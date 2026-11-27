export function createIdentityProvider({ url, key, http = fetch }) {
  if (!url || !key) throw new Error('Missing Supabase configuration');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.username || endpoint.password) {
    throw new Error('Use a Supabase HTTPS project URL');
  }

  async function call(path, method, data, token) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    try {
      const response = await http(endpoint.origin + '/auth/v1/' + path, {
        method, headers, redirect: 'error', body: JSON.stringify(data), signal: AbortSignal.timeout(10000)
      });
      if (response.status >= 500) return { unavailable: true };
      return response.ok ? { data: await response.json() } : {};
    } catch {
      return { unavailable: true };
    }
  }

  return {
    sendCode(email, purpose) {
      return purpose === 'register' ? call('otp', 'POST', { email, create_user: true })
        : call('recover', 'POST', { email });
    },
    verifyCode(email, code, purpose) {
      return call('verify', 'POST', { email, token: code, type: purpose === 'register' ? 'email' : 'recovery' });
    },
    setPassword(token, password) {
      return call('user', 'PUT', { password }, token);
    },
    signIn(email, password) {
      return call('token?grant_type=password', 'POST', { email, password });
    }
  };
}
