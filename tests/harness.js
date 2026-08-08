/* 极简测试框架：结果同时写进页面和 console，方便人看也方便自动化读取。 */
(function (root) {
  'use strict';

  const suites = [];
  let current = null;

  function suite(name, fn) {
    current = { name, results: [] };
    suites.push(current);
    fn();
    current = null;
  }

  function ok(condition, label) {
    current.results.push({ pass: !!condition, label });
  }

  function eq(actual, expected, label) {
    const pass = actual === expected;
    current.results.push({
      pass,
      label: pass ? label : `${label} —— 期望 ${expected}，实际 ${actual}`,
    });
  }

  function approx(actual, expected, tolerance, label) {
    const pass = Math.abs(actual - expected) <= tolerance;
    current.results.push({
      pass,
      label: `${label} —— 期望 ${expected}±${tolerance}，实际 ${typeof actual === 'number' ? actual.toFixed(4) : actual}`,
    });
  }

  function run() {
    let total = 0;
    let failed = 0;
    const lines = [];
    for (const s of suites) {
      lines.push(`<h2>${s.name}</h2>`);
      for (const r of s.results) {
        total++;
        if (!r.pass) failed++;
        lines.push(
          `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✅' : '❌'} ${r.label}</div>`
        );
      }
    }
    const summary = failed === 0
      ? `<div class="summary ok">全部通过：${total} 项 ✅</div>`
      : `<div class="summary bad">${failed} / ${total} 项失败 ❌</div>`;

    document.body.innerHTML = summary + lines.join('\n');
    root.__TEST_RESULT__ = { total, failed, failures: suites.flatMap(
      (s) => s.results.filter((r) => !r.pass).map((r) => `${s.name}: ${r.label}`)
    ) };
    console.log(`tests: ${total - failed}/${total} passed`);
  }

  root.T = { suite, ok, eq, approx, run };
})(window);
