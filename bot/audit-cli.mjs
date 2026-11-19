// 维护者用：给"不对劲"出结论。依据必填。
import { pendingReports, addFinding, clusters } from '/srv/digitallife/src/utils/reports.mjs';
const [cmd, id, verdict, evidence, say] = process.argv.slice(2);
if (cmd === 'list') {
  const cl = clusters();
  if (cl.length) {
    console.log('同类（同一规则/字段/关键词，14 天内 ≥3 次）：');
    for (const g of cl) console.log(`  ${g.kind}:${g.key}  ${g.ids.length} 次  ${g.ids.join(' ')}`);
    console.log('');
  }
  const rows = pendingReports();
  console.log(rows.length ? rows.map((r) => `${r.id}  ${r.text}`).join('\n') : '没有待审计的报告');
} else if (cmd === 'done') {
  const r = addFinding({ id, verdict, evidence, say });
  console.log('已记录结论：', JSON.stringify(r));
} else {
  console.log('用法: node audit-cli.mjs list | done <id> <defect|rule-cost|misread|unknown> "依据" "回她的话"');
}
