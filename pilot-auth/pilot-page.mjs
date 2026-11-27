const fixture = [
  { quantity: 10, price: 10000 },
  { quantity: 5, price: 12000 },
  { quantity: -12, price: 15000 }
];

export function calculateFixture() {
  const lots = [];
  let sale = 0;
  let cost = 0;
  for (const trade of fixture) {
    if (trade.quantity > 0) {
      lots.push({ ...trade });
      continue;
    }
    let remaining = -trade.quantity;
    sale += remaining * trade.price;
    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const used = Math.min(lot.quantity, remaining);
      lot.quantity -= used;
      remaining -= used;
      cost += used * lot.price;
      if (lot.quantity === 0) lots.shift();
    }
    if (remaining > 0) throw new Error('Not enough lots');
  }
  return { sale: sale / 100, cost: cost / 100, profit: (sale - cost) / 100 };
}

export function renderPilot(result, isAdmin) {
  const format = amount => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' USD';
  return new Response(`<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fin_rez — пилот</title>
<style>
  body{margin:0;padding:24px;background:#eef4fa;color:#172941;font:16px/1.5 system-ui,sans-serif}
  main{max-width:700px;margin:24px auto;background:#fff;border:1px solid #c9d9e8;padding:24px;border-radius:14px}
  form{margin:12px 0} button{font:inherit;padding:8px 14px;background:#164677;color:#fff;border:0;border-radius:8px}
  a{color:#15487b} dt{font-weight:600} dd{margin:0 0 10px} :focus-visible{outline:3px solid #138995;outline-offset:3px}
</style>
<main>
  <h1>Fin_rez — пилот</h1>
  <p>Контрольный расчёт FIFO на тестовых операциях. Покупка 10 бумаг по 100 USD и 5 по 120 USD, продажа 12 по 150 USD.</p>
  <form method="post" action="/api/calculate"><button>Рассчитать FIFO</button></form>
  ${result ? '<dl><dt>Выручка</dt><dd>' + format(result.sale) + '</dd><dt>Себестоимость</dt><dd>' + format(result.cost) + '</dd><dt>Прибыль</dt><dd>' + format(result.profit) + '</dd></dl>' : ''}
  ${isAdmin ? '<a href="/metrics">Метрики пилота</a>' : ''}
  <form method="post" action="/auth/logout"><button>Выйти</button></form>
</main>
</html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  } });
}

const metricLabels = {
  registration_completed: 'Регистрации',
  login_succeeded: 'Успешные входы',
  password_reset_completed: 'Восстановления пароля',
  calculation_succeeded: 'Расчёты FIFO',
  calculation_failed: 'Ошибки расчёта',
  xlsx_generated: 'Сформированные Excel'
};

export function renderMetrics(metrics) {
  const lines = [];
  for (const { day, event, count } of metrics) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Object.hasOwn(metricLabels, event) && Number.isSafeInteger(count)) {
      lines.push('<tr><td>' + day + '</td><td>' + metricLabels[event] + '</td><td>' + count + '</td></tr>');
    }
  }
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Метрики Fin_rez</title>
<style>
  body{margin:0;padding:24px;background:#eef4fa;color:#172941;font:16px/1.45 system-ui,sans-serif}
  main{max-width:780px;margin:auto;background:white;border:1px solid #c9d9e8;padding:24px;border-radius:14px}
  table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #c9d9e8;padding:8px;text-align:left}
  th{background:#e6f0fa}td:last-child{text-align:right}a{color:#15487b}
</style><main>
<h1>Метрики Fin_rez</h1><p>События за последние 30 дней по UTC.</p>
${lines.length ? '<table><thead><tr><th>Дата</th><th>Событие</th><th>Количество</th></tr></thead><tbody>' + lines.join('') + '</tbody></table>' : '<p>Событий пока нет.</p>'}
<a href="/">Вернуться к расчёту</a></main></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  } });
}
