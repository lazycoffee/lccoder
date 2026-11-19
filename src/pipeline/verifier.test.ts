import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { Verifier } from './verifier.js';

describe('Verifier', () => {
  let verifier: Verifier;

  beforeEach(() => {
    verifier = new Verifier('/mock/dir');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectProject', () => {
    it('should detect empty project properly', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(fsPromises, 'readFile').mockResolvedValue('{}' as any);

      const info = await verifier.detectProject();
      expect(info.hasTsConfig).toBe(false);
      expect(info.hasEslint).toBe(false);
      expect(info.hasTestScript).toBe(false);
      expect(info.packageManager).toBe('unknown'); // If no package.json, it's unknown
    });
  });

  describe('verify', () => {
    it('should run only available checks', async () => {
      // Mock detectProject directly
      vi.spyOn(verifier, 'detectProject').mockResolvedValue({
        hasTsConfig: true,
        hasEslint: false,
        hasTestScript: false,
        packageManager: 'npm'
      });

      // Mock runCheck
      const runCheckSpy = vi.spyOn(verifier as any, 'runCheck').mockResolvedValue({
        name: 'TypeScript 类型检查',
        passed: true,
        output: '',
        durationMs: 100,
      });

      const report = await verifier.verify();
      
      expect(report.checks.length).toBe(1);
      expect(report.checks[0]?.name).toBe('TypeScript 类型检查');
      expect(report.allPassed).toBe(true);
      expect(runCheckSpy).toHaveBeenCalledTimes(1);
      expect(runCheckSpy).toHaveBeenCalledWith('TypeScript 类型检查', 'npx tsc --noEmit');
    });

    it('should run tests if tests are available and other checks passed', async () => {
      vi.spyOn(verifier, 'detectProject').mockResolvedValue({
        hasTsConfig: false,
        hasEslint: false,
        hasTestScript: true,
        packageManager: 'bun'
      });

      const runCheckSpy = vi.spyOn(verifier as any, 'runCheck').mockResolvedValue({
        name: '测试运行',
        passed: true,
        output: 'passed',
        durationMs: 100,
      });

      const report = await verifier.verify();
      
      expect(report.checks.length).toBe(1);
      expect(report.checks[0]?.name).toBe('测试运行');
      expect(runCheckSpy).toHaveBeenCalledWith('测试运行', 'bun test');
    });

    it('should skip tests when includeTests is false', async () => {
      vi.spyOn(verifier, 'detectProject').mockResolvedValue({
        hasTsConfig: false,
        hasEslint: false,
        hasTestScript: true,
        packageManager: 'bun'
      });

      const runCheckSpy = vi.spyOn(verifier as any, 'runCheck').mockResolvedValue({
        name: '测试运行',
        passed: true,
        output: 'passed',
        durationMs: 100,
      });

      const report = await verifier.verify({ includeTests: false });

      expect(report.checks.length).toBe(0);
      expect(runCheckSpy).not.toHaveBeenCalled();
    });

    it('should preserve debug profile in verification report', async () => {
      vi.spyOn(verifier, 'detectProject').mockResolvedValue({
        hasTsConfig: false,
        hasEslint: false,
        hasTestScript: true,
        packageManager: 'bun'
      });

      vi.spyOn(verifier as any, 'runCheck').mockResolvedValue({
        name: '测试运行',
        passed: true,
        output: 'passed',
        durationMs: 100,
      });

      const report = await verifier.verify({ includeTests: true, profile: 'debug' });

      expect(report.profile).toBe('debug');
    });
  });
});
