#!/usr/bin/env node

const { getBackupConfig, migrateSnapshotFolders } = require('./cloudBackup.js');

function usage() {
  console.log([
    '用法：',
    '  npm run migrate:snapshots -- --dry-run',
    '  npm run migrate:snapshots -- --apply',
    '',
    '说明：',
    '  旧版快照位于 snapshots/ 根目录；脚本会读取每份快照清单的 createdAt，',
    '  将它移动到 snapshots/YYYY-MM/，latest.json 保持在根目录并同步更新指针，objects/ 不会移动。',
    '  默认只预览，不写入；确认预览结果后再使用 --apply。',
    '  脚本按“先复制、更新指针、再删除旧路径”执行；目标已存在且内容一致时只清理旧路径，内容冲突会停止迁移。',
  ].join('\n'));
}

function parseArgs(args) {
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}，可用参数为 --dry-run 或 --apply`);
    }
  }
  return { apply };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const result = await migrateSnapshotFolders(getBackupConfig(), { apply });
  if (result.dryRun) {
    console.log(`预览完成：发现 ${result.legacyCount} 份旧快照，${result.moveCount} 份待移动，${result.duplicateCount} 份可清理重复项。`);
    for (const plan of result.plans) console.log(`  ${plan.sourcePath} → ${plan.destinationPath}`);
    console.log('未写入任何远程文件；确认无误后执行：npm run migrate:snapshots -- --apply');
  } else {
    console.log(`迁移完成：移动 ${result.moveCount} 份快照，清理 ${result.duplicateCount} 份重复旧路径。`);
    if (result.months.length) console.log(`月份目录：${result.months.join('、')}`);
  }
}

main().catch(error => {
  console.error(`[SNAPSHOT-MIGRATE] ${error.message}`);
  process.exitCode = 1;
});
