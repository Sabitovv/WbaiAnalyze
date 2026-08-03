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
  register:     (login, password, name, pattern) => req('POST', '/auth/register', { login, password, name, pattern }),

  getUsers:     ()       => req('GET',    '/users'),
  deleteUser:      (id)              => req('DELETE', `/users/${id}`),
  changePassword:  (id, old_password, new_password) => req('PUT', `/users/${id}/password`, { old_password, new_password }),

  getCatalog:   ()       => req('GET',    '/catalog'),
  addProduct:   (p)      => req('POST',   '/catalog', p),
  updateProduct:(id, p)  => req('PUT',    `/catalog/${id}`, p),
  deleteProduct:(id)     => req('DELETE', `/catalog/${id}`),

  syncProducts: (cabId)  => req('POST',   `/wb/sync-products/${cabId}`),
  importCommission: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(base + '/catalog/import-commission', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка импорта');
    return data;
  },
  applyCommission: (rates) => req('POST', '/catalog/apply-commission', { rates }),

  getUserCabs:    (userId)          => req('GET',  `/user-cabs/${userId}`),
  setUserCabs:    (userId, cab_ids) => req('PUT',  `/user-cabs/${userId}`, { cab_ids }),
  setSalary:      (userId, pct)     => req('PUT',  `/users/${userId}/salary`, { salary_pct: pct }),

  getTeams:       ()                => req('GET',    '/teams'),
  addTeam:        (name)            => req('POST',   '/teams', { name }),
  deleteTeam:     (id)              => req('DELETE', `/teams/${id}`),
  setTeamMembers: (id, user_ids)    => req('PUT',    `/teams/${id}/members`, { user_ids }),

  getCabs:      ()              => req('GET',    '/cabs'),
  getCab:       (id)            => req('GET',    `/cabs/${id}`),
  addCab:       (name, buyout, cab_type) => req('POST',   '/cabs', { name, buyout, cab_type }),
  updateCab:    (id, data)     => req('PUT',    `/cabs/${id}`, data),
  deleteCab:    (id)           => req('DELETE', `/cabs/${id}`),

  getSettings:  ()              => req('GET',    '/settings'),
  setSettings:  (data)          => req('PUT',    '/settings', data),

  syncCab:      (id)            => req('POST',   `/wb/sync/${id}`),
  importWb:     (id, dateFrom, dateTo) => req('POST', `/wb/import/${id}${dateFrom ? `?dateFrom=${dateFrom}&dateTo=${dateTo}` : ''}`),
  importAllWb:  (dateFrom, dateTo) => req('POST', `/wb/import-all${dateFrom ? `?dateFrom=${dateFrom}&dateTo=${dateTo}` : ''}`),
  seedDemoWb:   (id, days=7)     => req('POST',   `/wb/seed-demo/${id}?days=${days}`),
  seedDemoAdsWb:(id, days=7)     => req('POST',   `/wb/seed-demo-ads/${id}?days=${days}`),
  getWbAdverts: (id, dateFrom, dateTo) => req('GET', `/wb/adverts/${id}${dateFrom ? `?dateFrom=${dateFrom}&dateTo=${dateTo}` : ''}`),
  getWbAdvertMetrics: (cabId, dateFrom, dateTo) => req('GET', `/wb/advert-metrics?cabId=${cabId || 'all'}&dateFrom=${dateFrom || ''}&dateTo=${dateTo || ''}`),
  getSchedulerStatus: () => req('GET', '/wb/scheduler-status'),
  runScheduler: () => req('POST', '/wb/scheduler-run'),

  getUserGoals:  (month)        => req('GET', `/user-goals?month=${month}`),
  setUserGoal:   (userId, month, goal) => req('PUT', `/user-goals/${userId}/${month}`, { goal }),

  getHistory:      ()        => req('GET',    '/history'),
  getHistoryItems: ()        => req('GET',    '/history-items'),
  addHistory:      (rec)     => req('POST',   '/history', rec),
  updateHistory: (id, rec) => req('PUT',    `/history/${id}`, rec),
  deleteRecord:  (id)      => req('DELETE', `/history/${id}`),
  clearHistory:  ()        => req('DELETE', '/history'),

  getDashboard: (dateFrom, dateTo, userId) => req('GET', `/dashboard?dateFrom=${dateFrom || ''}&dateTo=${dateTo || ''}&userId=${userId || ''}`),

  updateUser:         (id, data)          => req('PUT',    `/users/${id}`, data),
  getUserReport:      (id, dateFrom, dateTo) => req('GET', `/users/report?userId=${id}&dateFrom=${dateFrom}&dateTo=${dateTo}`),
  getUserDetail:      (id, dateFrom, dateTo) => req('GET', `/users/report-detail?userId=${id}&dateFrom=${dateFrom}&dateTo=${dateTo}`),
  getUserCampaigns:   (id, dateFrom, dateTo) => req('GET', `/users/${id}/campaigns?dateFrom=${dateFrom}&dateTo=${dateTo}`),
  getUnassignedCampaigns: (dateFrom, dateTo) => req('GET', `/campaigns/unassigned?dateFrom=${dateFrom}&dateTo=${dateTo}`),
  getDailyReport:       (dateFrom, dateTo, cabId = 'all') => req('GET', `/reports/daily?dateFrom=${dateFrom}&dateTo=${dateTo}&cabId=${cabId}`),
  getCategoryReport:    (dateFrom, dateTo, cabId = 'all') => req('GET', `/reports/category?dateFrom=${dateFrom}&dateTo=${dateTo}&cabId=${cabId}`),
  getMonthlyReport:     (dateFrom, dateTo, cabId = 'all') => req('GET', `/reports/monthly?dateFrom=${dateFrom}&dateTo=${dateTo}&cabId=${cabId}`),
  getArticleReport:     (dateFrom, dateTo, cabId = 'all') => req('GET', `/reports/article?dateFrom=${dateFrom}&dateTo=${dateTo}&cabId=${cabId}`),
  getProductReport:     (dateFrom, dateTo, cabId = 'all') => req('GET', `/reports/product?dateFrom=${dateFrom}&dateTo=${dateTo}&cabId=${cabId}`),

  getImportRuns: ({cabId, dateFrom, dateTo, limit = 50} = {}) => {
    const params = new URLSearchParams();
    if (cabId != null && cabId !== '') params.set('cabId', cabId);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    params.set('limit', String(limit));
    return req('GET', `/wb/import-runs?${params.toString()}`);
  },
  getImportStatus: () => req('GET', '/wb/import-status'),
};
