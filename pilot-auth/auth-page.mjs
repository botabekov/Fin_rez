const emailInput = '<label>Электронная почта<input name="email" type="email" autocomplete="username" maxlength="254" required></label>';
const newPassword = '<label>Новый пароль<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>';

const screens = {
  login: {
    title: 'Вход в Fin_rez',
    action: '/auth/login',
    fields: emailInput + '<label>Пароль<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>',
    button: 'Войти',
    links: '<a href="/register">Зарегистрироваться</a><a href="/recover">Забыли пароль?</a>'
  },
  register: {
    title: 'Регистрация в Fin_rez',
    action: '/auth/register',
    fields: emailInput,
    button: 'Получить код'
  },
  recover: {
    title: 'Восстановление пароля',
    action: '/auth/recover',
    fields: emailInput,
    button: 'Получить код'
  },
  verify: {
    title: 'Подтвердите электронную почту',
    action: '/auth/verify',
    fields: '<label>Одноразовый код<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>',
    button: 'Подтвердить код'
  },
  password: {
    title: 'Создайте пароль',
    action: '/auth/password',
    fields: newPassword + '<label>Повторите пароль<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>',
    button: 'Сохранить пароль'
  }
};

const notices = {
  sent: 'Если адрес подходит для выбранного действия, на него придёт код.',
  invalidCode: 'Код просрочен или введён неверно. Проверьте код или запросите новый.',
  invalidLogin: 'Проверьте электронную почту и пароль.',
  mismatch: 'Пароли должны совпадать. Введите минимум 12 символов. Если пароль слишком длинный, сократите его.',
  passwordFailed: 'Не удалось сохранить пароль. Запросите новый код и повторите попытку.',
  rateLimit: 'Слишком много попыток. Повторите позже.',
  expired: 'Срок действия подтверждения истёк. Запросите новый код.'
};

export function renderAuthPage(view, notice) {
  const screen = Object.hasOwn(screens, view) ? screens[view] : screens.login;
  const message = Object.hasOwn(notices, notice) ? '<p role="status">' + notices[notice] + '</p>' : '';
  return new Response(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${screen.title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100svh; padding: 24px; display: grid; place-items: center;
    background: #eef4fa; color: #172941; font: 16px/1.45 system-ui, sans-serif; }
  main { width: min(100%, 420px); padding: clamp(20px, 6vw, 36px); background: white;
    border: 1px solid #c9d9e8; border-radius: 16px; }
  h1 { margin: 0 0 24px; font-size: 1.65rem; line-height: 1.2; }
  form, label { display: grid; gap: 8px; }
  form { gap: 18px; }
  input, button { min-height: 44px; padding: 8px 12px; font: inherit; border-radius: 8px; }
  input { width: 100%; border: 1px solid #728ba3; }
  button { background: #164677; color: white; border: 1px solid #164677; cursor: pointer; }
  nav { display: flex; gap: 12px 20px; flex-wrap: wrap; margin-top: 20px; }
  a { color: #103e69; }
  :focus-visible { outline: 3px solid #138995; outline-offset: 3px; }
  p[role=status] { padding: 10px 12px; background: #edf5fd; border-radius: 8px; }
</style>
</head>
<body>
<main>
<h1>${screen.title}</h1>
${message}
<form method="post" action="${screen.action}">${screen.fields}<button type="submit">${screen.button}</button></form>
<nav aria-label="Действия с аккаунтом">${screen.links || '<a href="/login">Вернуться ко входу</a>'}</nav>
</main>
</body>
</html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  } });
}
