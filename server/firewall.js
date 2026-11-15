'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { IS_WIN, SLOTS_DIR, MAX_SLOTS, FIREWALL_GROUP, BDS_EXE } = require('./paths');

// Read-only check of whether firewall-setup.ps1 has registered allow rules for every slot executable.
// Without them Windows asks "allow access?" the first time each slot runs a server — nobody can click
// that on an unattended machine. Reading rules doesn't need admin rights; creating them does.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

class FirewallCheck extends EventEmitter {
  constructor() {
    super();
    this.state = { supported: IS_WIN, ok: null, missing: null, blocked: 0, checkedAt: null, error: null, checking: false };
    this.running = null;
  }

  expectedPrograms() {
    const list = [];
    for (let n = 1; n <= MAX_SLOTS; n++) list.push(path.join(SLOTS_DIR, String(n), BDS_EXE));
    return list;
  }

  check() {
    if (!IS_WIN) return Promise.resolve(this.state);
    if (this.running) return this.running;
    this.state = { ...this.state, checking: true };
    this.emit('change');
    const prefix = `${SLOTS_DIR}${path.sep}`;
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `$allow = @(Get-NetFirewallRule -Group ${psQuote(FIREWALL_GROUP)} -ErrorAction SilentlyContinue |`,
      "  Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } |",
      '  Get-NetFirewallApplicationFilter | ForEach-Object { $_.Program })',
      // A "Cancel" on Windows' prompt creates block rules, and block rules win over allow rules.
      `$prefix = ${psQuote(prefix)}`,
      '$blocked = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and $_.Program.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |',
      "  Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' }).Count",
      '@{ allow = $allow; blocked = $blocked } | ConvertTo-Json -Compress',
    ].join('\n');

    this.running = new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          let next;
          try {
            if (err) throw err;
            const out = JSON.parse(stdout.trim() || '{}');
            const allowed = new Set([].concat(out.allow || []).map((p) => String(p).toLowerCase()));
            const missing = this.expectedPrograms().filter((p) => !allowed.has(p.toLowerCase())).length;
            const blocked = Number(out.blocked) || 0;
            next = { supported: true, ok: missing === 0 && blocked === 0, missing, blocked, checkedAt: Date.now(), error: null, checking: false };
          } catch (e) {
            next = { ...this.state, checking: false, checkedAt: Date.now(), error: `방화벽 규칙을 확인하지 못했습니다: ${e.message.split('\n')[0]}` };
          }
          this.state = next;
          this.running = null;
          this.emit('change');
          resolve(next);
        });
    });
    return this.running;
  }
}

module.exports = { FirewallCheck };
