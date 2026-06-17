const base = '/api';

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

export const api = {
  login:        (login, password)  => req('POST', '/auth/login',    { login, password }),
  register:     (login, password, name) => req('POST', '/auth/register', { login, password, name }),

  getUsers:     ()       => req('GET',    '/users'),
  deleteUser:   (id)     => req('DELETE', `/users/${id}`),

  getCatalog:   ()       => req('GET',    '/catalog'),
  addProduct:   (p)      => req('POST',   '/catalog', p),
  updateProduct:(id, p)  => req('PUT',    `/catalog/${id}`, p),
  deleteProduct:(id)     => req('DELETE', `/catalog/${id}`),

  getUserCabs:    (userId)          => req('GET',  `/user-cabs/${userId}`),
  setUserCabs:    (userId, cab_ids) => req('PUT',  `/user-cabs/${userId}`, { cab_ids }),

  getCabs:      ()              => req('GET',    '/cabs'),
  addCab:       (name, buyout) => req('POST',   '/cabs', { name, buyout }),
  updateCab:    (id, data)     => req('PUT',    `/cabs/${id}`, data),
  deleteCab:    (id)           => req('DELETE', `/cabs/${id}`),

  getHistory:   ()       => req('GET',    '/history'),
  addHistory:   (rec)    => req('POST',   '/history', rec),
  deleteRecord: (id)     => req('DELETE', `/history/${id}`),
  clearHistory: ()       => req('DELETE', '/history'),
};
