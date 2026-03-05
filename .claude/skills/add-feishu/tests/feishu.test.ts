import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-feishu skill', () => {
  it('has valid manifest', () => {
    const manifestPath = path.join(SKILL_DIR, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skill).toBe('feishu');
    expect(manifest.adds).toContain('src/channels/feishu.ts');
    expect(manifest.adds).toContain('src/channels/feishu.test.ts');
  });

  it('has SKILL.md', () => {
    const skillMdPath = path.join(SKILL_DIR, 'SKILL.md');
    expect(fs.existsSync(skillMdPath)).toBe(true);
  });

  it('has channel implementation', () => {
    const channelPath = path.join(SKILL_DIR, 'add/src/channels/feishu.ts');
    expect(fs.existsSync(channelPath)).toBe(true);
  });

  it('has channel tests', () => {
    const testPath = path.join(SKILL_DIR, 'add/src/channels/feishu.test.ts');
    expect(fs.existsSync(testPath)).toBe(true);
  });

  it('has config modification', () => {
    const configPath = path.join(SKILL_DIR, 'modify/src/config.ts');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    expect(configContent).toContain('FEISHU_APP_ID');
    expect(configContent).toContain('FEISHU_APP_SECRET');
    expect(configContent).toContain('FEISHU_ONLY');
  });
});
