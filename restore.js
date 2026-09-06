#!/usr/bin/env node

const path = require('path');
const { getBackupConfig, restoreBackup } = require('./cloudBackup.js');

function usage() {
  console.error([
    '用法：',
    '  TODO_CONFIG_DIR=/config node restore.js --output-dir /path/to/new-data [--snapshot latest|snapshots/<id>.json]',
    '',
    '说明：',
    '  --output-dir 必须指向一个尚不存在的目录，工具不会覆盖已有目录。',
    '  恢复内容包括 todo.db 和 notes/；配置密钥不在备份中。',
  ].join('\n'));
}

function parseArgs(args) {
  const options = { snapshot: 'latest', outputDir: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot') {
      options.snapshot = args[++i];
      if (!options.snapshot) throw new Error('--snapshot 缺少参数');
    } else if (arg === '--output-dir') {
      options.outputDir = args[++i];
      if (!options.outputDir) throw new Error('--output-dir 缺少参数');
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.outputDir) throw new Error('必须指定 --output-dir');
  options.outputDir = path.resolve(options.outputDir);
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
  const result = await restoreBackup(getBackupConfig(), options);
  console.log(`恢复完成：${result.outputDir}`);
  console.log(`快照：${result.snapshotPath}`);
  console.log(`数据库 SHA-256：${result.databaseHash}`);
  console.log(`Markdown 笔记：${result.noteCount} 个`);
  console.log('请先检查恢复目录，再停止当前服务并按需替换数据目录。');
}

main().catch(error => {
  console.error(`[RESTORE] ${error.message}`);
  process.exitCode = 1;
});
