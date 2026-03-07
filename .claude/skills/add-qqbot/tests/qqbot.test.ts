import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('qqbot skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: qqbot');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('QQBOT_APP_ID');
    expect(content).toContain('QQBOT_APP_SECRET');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(skillDir, 'add', 'src', 'channels', 'qqbot.ts');
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class QQBotChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('qqbot'");

    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'qqbot.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('QQBotChannel'");
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    const verifyFile = path.join(skillDir, 'modify', 'setup', 'verify.ts');
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(verifyFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    const verifyContent = fs.readFileSync(verifyFile, 'utf-8');
    expect(indexContent).toContain("import './qqbot.js'");
    expect(verifyContent).toContain('QQBOT_APP_ID');
    expect(verifyContent).toContain('QQBOT_APP_SECRET');
    expect(verifyContent).toContain('channelAuth.qqbot');
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'setup', 'verify.ts.intent.md'),
      ),
    ).toBe(true);
  });
});
