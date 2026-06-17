import { useState, useEffect, useMemo } from "react";
import { api } from "./api";

// ── Утилиты ───────────────────────────────────────────────────────────────────
function logRub(w, d, h) {
  if (!w || !d || !h) return null;
  const v = (w * d * h) / 1000;
  if (v <= 0.2) return v * 23;
  if (v <= 0.4) return v * 26;
  if (v <= 0.6) return v * 29;
  if (v <= 0.8) return v * 30;
  if (v <= 1.0) return v * 32;
  return 46 + (v - 1) * 14;
}

const fmt  = n => { const a = Math.round(Math.abs(n)); return (n < 0 ? '−' : '') + a.toLocaleString('ru'); };
const fmtP = n => (isNaN(n) || !isFinite(n)) ? '0.0' : n.toFixed(1);
const num  = v => parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
const toDay = () => new Date().toISOString().split('T')[0];
const initials = name => (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

const PERIODS = [
  { k: 'day',   l: 'День',     days: 1 },
  { k: 'week',  l: 'Неделя',   days: 7 },
  { k: 'month', l: 'Месяц',    days: 30 },
  { k: 'half',  l: 'Полгода',  days: 182 },
  { k: 'year',  l: 'Год',      days: 365 },
  { k: 'all',   l: 'Всё время',days: Infinity },
];

function kpiColor(type, val) {
  if (type === 'margin') return val >= 10 ? 'var(--green-txt)' : val >= 0 ? 'var(--yellow-txt)' : 'var(--red-txt)';
  if (type === 'drr')    return val <= 8  ? 'var(--green-txt)' : val <= 12 ? 'var(--yellow-txt)' : 'var(--red-txt)';
  if (type === 'profit') return val >= 0  ? 'var(--green-txt)' : 'var(--red-txt)';
  return 'var(--blue-txt)';
}

function filterByRange(list, dateField, { period, dateFrom, dateTo }) {
  if (dateFrom || dateTo) {
    return list.filter(r => {
      const d = (r[dateField] || '').split('T')[0];
      if (dateFrom && d < dateFrom) return false;
      if (dateTo   && d > dateTo)   return false;
      return true;
    });
  }
  const p = PERIODS.find(x => x.k === period);
  if (!p || p.days === Infinity) return list;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - p.days);
  return list.filter(r => new Date(r[dateField]) >= cutoff);
}

// ── Поле формы (вне LoginScreen чтобы не терять фокус при ре-рендере) ─────────
function FormField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="form-input" type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </div>
  );
}

// ── Экран входа / регистрации ─────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [tab,     setTab]     = useState('login');
  const [login,   setLogin]   = useState('');
  const [pass,    setPass]    = useState('');
  const [pass2,   setPass2]   = useState('');
  const [name,    setName]    = useState('');
  const [err,     setErr]     = useState('');
  const [ok,      setOk]      = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => { setErr(''); setOk(''); };

  const submitLogin = async e => {
    e.preventDefault(); reset(); setLoading(true);
    try { onLogin(await api.login(login.trim(), pass)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const submitReg = async e => {
    e.preventDefault(); reset();
    if (!login.trim())   return setErr('Введите логин');
    if (!name.trim())    return setErr('Введите имя');
    if (pass.length < 4) return setErr('Пароль минимум 4 символа');
    if (pass !== pass2)  return setErr('Пароли не совпадают');
    setLoading(true);
    try {
      await api.register(login.trim(), pass, name.trim());
      setOk('Аккаунт создан! Войдите.');
      setTimeout(() => { setTab('login'); setOk(''); }, 2000);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">WB Analytics</div>
        <div className="auth-sub">Единая система учёта прибыли компании</div>
        <div className="auth-tabs">
          {[{ k: 'login', l: 'Войти' }, { k: 'reg', l: 'Регистрация' }].map(t => (
            <button key={t.k} className={`auth-tab ${tab === t.k ? 'active' : ''}`}
              onClick={() => { setTab(t.k); reset(); }}>{t.l}</button>
          ))}
        </div>
        {err && <div className="err-msg">{err}</div>}
        {ok  && <div className="ok-msg">{ok}</div>}
        {tab === 'login' ? (
          <form onSubmit={submitLogin}>
            <FormField label="Логин" value={login} onChange={setLogin} placeholder="your_login" />
            <FormField label="Пароль" value={pass} onChange={setPass} type="password" placeholder="••••••" />
            <button type="submit" className="auth-submit primary" disabled={loading}>
              {loading ? 'Вход...' : 'Войти →'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitReg}>
            <FormField label="Полное имя" value={name} onChange={setName} placeholder="Иван Иванов" />
            <FormField label="Логин" value={login} onChange={setLogin} placeholder="ivan_ivanov" />
            <FormField label="Пароль" value={pass} onChange={setPass} type="password" placeholder="минимум 4 символа" />
            <FormField label="Повтор пароля" value={pass2} onChange={setPass2} type="password" placeholder="••••••" />
            <button type="submit" className="auth-submit success" disabled={loading}>
              {loading ? 'Создание...' : 'Зарегистрироваться'}
            </button>
            <div className="auth-note">Аккаунт создаётся со статусом «Сотрудник»</div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Модалка редактирования товара ─────────────────────────────────────────────
function ProductModal({ prod, onSave, onClose }) {
  const [form,   setForm]   = useState({ name: prod.name || '', cost: prod.cost || 0, comm: prod.comm || 25, w: prod.w || 0, d: prod.d || 0, h: prod.h || 0 });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const vol = form.w && form.d && form.h ? ((+form.w * +form.d * +form.h) / 1000).toFixed(3) : null;
  const lr  = vol ? logRub(+form.w, +form.d, +form.h) : null;

  const submit = async e => {
    e.preventDefault();
    if (!form.name.trim()) return setErr('Введите название');
    setSaving(true);
    try { await onSave({ ...prod, ...form, cost: +form.cost, comm: +form.comm, w: +form.w, d: +form.d, h: +form.h }); }
    catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>{prod.id ? 'Редактировать товар' : 'Новый товар'}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 16 }}>
            <label className="form-label">Название товара</label>
            <input className="form-input" value={form.name} onChange={set('name')} placeholder="Название" autoFocus />
          </div>
          <div className="form-grid-2" style={{ marginBottom: 16 }}>
            <div>
              <label className="form-label">Себестоимость, ₸</label>
              <input type="number" className="form-input" value={form.cost} onChange={set('cost')} min="0" />
            </div>
            <div>
              <label className="form-label">Комиссия WB, %</label>
              <input type="number" className="form-input" value={form.comm} onChange={set('comm')} min="0" max="100" step="0.1" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="form-label">Габариты упаковки (см)</label>
            <div className="form-grid-3">
              {[['w', 'Ширина'], ['d', 'Глубина'], ['h', 'Высота']].map(([k, l]) => (
                <div key={k}>
                  <label className="form-label" style={{ fontSize: 10 }}>{l}</label>
                  <input type="number" className="form-input" value={form[k]} onChange={set(k)} min="0" />
                </div>
              ))}
            </div>
          </div>
          {vol && (
            <div className="info-box" style={{ marginBottom: 16, display: 'flex', gap: 20 }}>
              <span>Объём: <strong>{vol} л</strong></span>
              {lr && <span>Логистика WB: <strong style={{ color: 'var(--yellow-txt)' }}>~{lr.toFixed(1)} ₽/шт</strong></span>}
            </div>
          )}
          {err && <div className="err-msg">{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-lg" style={{ flex: 1 }} disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button type="button" className="btn btn-lg" onClick={onClose}>Отмена</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Строка товара ─────────────────────────────────────────────────────────────
function ProdRow({ row, catalog, rate, coeff, isAdmin, onUpdate, onDel }) {
  const prod  = catalog.find(p => p.name === row.product) || catalog[0] || {};
  const lr    = logRub(prod.w, prod.d, prod.h);
  const lKzt  = lr !== null ? lr * coeff * rate : null;
  const qty   = num(row.qty);

  return (
    <div className="prod-row" style={{ gridTemplateColumns: isAdmin ? '1fr 60px 90px 60px 60px 90px 32px' : '1fr 80px 60px 90px 32px' }}>
      <select value={row.product} className="form-input" style={{ fontSize: 12 }}
        onChange={e => onUpdate(row.id, 'product', e.target.value)}>
        {catalog.map(p => <option key={p.id}>{p.name}</option>)}
      </select>
      <input type="number" value={row.qty} placeholder="0" min="0" className="form-input" style={{ fontSize: 12, textAlign: 'center' }}
        onChange={e => onUpdate(row.id, 'qty', e.target.value)} />
      {isAdmin && (
        <input type="number" value={row.cost} min="0" className="form-input" style={{ fontSize: 12, textAlign: 'right' }}
          onChange={e => onUpdate(row.id, 'cost', e.target.value)} />
      )}
      {isAdmin && (
        <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: 'var(--blue-txt)',
          background: 'var(--blue-bg)', borderRadius: 6, padding: '6px 4px' }}>{row.comm}%</div>
      )}
      <div style={{ textAlign: 'center', fontSize: 11, color: lKzt === null ? 'var(--yellow-txt)' : 'var(--txt2)' }}>
        {lKzt === null ? '—' : Math.round(lKzt)}
      </div>
      <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>
        {lKzt === null ? '—' : fmt(qty * (lKzt ?? 0)) + ' ₸'}
      </div>
      <button className="prod-del" onClick={() => onDel(row.id)}>×</button>
    </div>
  );
}

// ── Панель результата ─────────────────────────────────────────────────────────
function ResultPanel({ c }) {
  const profitColor = c.profit >= 0 ? 'var(--green-txt)' : 'var(--red-txt)';
  const Row = ({ label, value, color, note }) => (
    <div className="result-row">
      <span style={{ color: 'var(--txt2)', fontSize: 12 }}>
        {label}{note && <span style={{ fontSize: 10, color: 'var(--txt3)', marginLeft: 4 }}>({note})</span>}
      </span>
      <span style={{ fontWeight: 600, color, fontSize: 13 }}>{value}</span>
    </div>
  );

  return (
    <div className="card" style={{ padding: '20px 24px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 4 }}>Результат за день</div>
      <div className="result-profit" style={{ color: profitColor }}>{fmt(c.profit)} ₸</div>
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--txt3)', marginBottom: 20 }}>чистая прибыль</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        {[
          { l: 'Маржа', v: fmtP(c.margin) + '%', col: kpiColor('margin', c.margin) },
          { l: 'ДРР',   v: fmtP(c.drr) + '%',    col: kpiColor('drr', c.drr) },
        ].map(k => (
          <div key={k.l} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px', textAlign: 'center', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.col }}>{k.v}</div>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>{k.l}</div>
          </div>
        ))}
      </div>
      <hr className="divider" />
      <Row label="Выручка"             value={'+' + fmt(c.rev) + ' ₸'}     color="var(--blue-txt)" />
      <Row label="Себестоимость"       value={'−' + fmt(c.cost) + ' ₸'}    color="var(--red-txt)" />
      <Row label="Реклама"             value={'−' + fmt(c.ads) + ' ₸'}     color="var(--yellow-txt)" note={c.adsRub ? `${fmt(c.adsRub)} ₽` : null} />
      <Row label="Комиссия WB"         value={'−' + fmt(c.comm) + ' ₸'}    color="var(--red-txt)" />
      <Row label="Логистика доставки"  value={'−' + fmt(c.logF) + ' ₸'}    color="var(--txt2)" note="по объёму" />
      <Row label="Логистика возвратов" value={'−' + fmt(c.logR) + ' ₸'}    color="var(--txt2)" note="50₽×возвр" />
      <Row label="Потери на возвраты"  value={'−' + fmt(c.ret) + ' ₸'}     color="var(--red-txt)" note="(1−выкуп)%" />
      <div className="result-total" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
        <span>Прибыль</span>
        <span style={{ color: profitColor }}>{fmt(c.profit)} ₸</span>
      </div>
    </div>
  );
}

// ── Фильтр-блок (период + диапазон дат + кабинет) ────────────────────────────
function FilterBar({ period, setPeriod, dateFrom, setDateFrom, dateTo, setDateTo, cabinet, setCabinet, cabinets, showCabFilter = false }) {
  const hasRange = dateFrom || dateTo;
  return (
    <div className="card" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="pills">
        {PERIODS.map(p => (
          <button key={p.k} className={`pill ${!hasRange && period === p.k ? 'active' : ''}`}
            onClick={() => { setPeriod(p.k); setDateFrom(''); setDateTo(''); }}>{p.l}</button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderLeft: '1px solid var(--border)', paddingLeft: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>От</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="form-input" style={{ width: 140, fontSize: 12 }} />
        <span style={{ fontSize: 11, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>до</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="form-input" style={{ width: 140, fontSize: 12 }} />
        {hasRange && (
          <button className="btn" style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
            onClick={() => { setDateFrom(''); setDateTo(''); }}>✕ Сбросить</button>
        )}
      </div>

      {showCabFilter && cabinets && cabinets.length > 0 && (
        <select value={cabinet} onChange={e => setCabinet(e.target.value)}
          className="form-input" style={{ width: 180, fontSize: 12, marginLeft: 'auto' }}>
          <option value="all">Все магазины</option>
          {cabinets.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Лучший сотрудник ──────────────────────────────────────────────────────────
function TopEmployees({ history, users }) {
  const medals = ['🥇', '🥈', '🥉'];
  const tops = useMemo(() => {
    const calc = (days) => {
      let h = history;
      if (days !== Infinity) {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
        h = history.filter(r => new Date(r.date) >= cutoff);
      }
      const map = {};
      h.forEach(r => {
        const k = r.user_login || '—';
        if (!map[k]) map[k] = { profit: 0, rev: 0 };
        map[k].profit += parseFloat(r.profit) || 0;
        map[k].rev    += parseFloat(r.rev)    || 0;
      });
      return Object.entries(map)
        .map(([login, m]) => {
          const u = users.find(u => u.login === login);
          return { login, name: u?.name || login, ...m,
            margin: m.rev > 0 ? m.profit / m.rev * 100 : 0 };
        })
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3);
    };
    return {
      day:   calc(1),
      week:  calc(7),
      month: calc(30),
    };
  }, [history, users]);

  const [tab, setTab] = useState('week');
  const list = tops[tab];

  if (!list.length) return null;

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="section-title">🏆 Лучшие сотрудники</div>
        <div className="pills">
          {[{ k: 'day', l: 'Сегодня' }, { k: 'week', l: 'Неделя' }, { k: 'month', l: 'Месяц' }].map(t => (
            <button key={t.k} className={`pill ${tab === t.k ? 'active' : ''}`}
              onClick={() => setTab(t.k)}>{t.l}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {list.map((u, i) => (
          <div key={u.login} style={{
            flex: 1, background: i === 0 ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${i === 0 ? 'rgba(245,158,11,0.25)' : 'var(--border)'}`,
            borderRadius: 12, padding: '16px', textAlign: 'center'
          }}>
            <div style={{ fontSize: 28, marginBottom: 6 }}>{medals[i]}</div>
            <div className="avatar" style={{ width: 36, height: 36, fontSize: 13, margin: '0 auto 8px' }}>
              {initials(u.name)}
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{u.name}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: kpiColor('profit', u.profit), letterSpacing: '-0.02em' }}>
              {fmt(u.profit)} ₸
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>
              маржа {fmtP(u.margin)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Администратор ─────────────────────────────────────────────────────────────
function AdminPanel({ catalog, setCatalog, cabs, setCabs, users, setUsers, allCabs }) {
  const [tab,        setTab]        = useState('products');
  const [editProd,   setEditProd]   = useState(null);
  const [showNew,    setShowNew]    = useState(false);
  const [delProdId,  setDelProdId]  = useState(null);
  const [newCab,     setNewCab]     = useState('');
  const [newUser,    setNewUser]    = useState({ login: '', password: '', name: '' });
  const [addingUser, setAddingUser] = useState(false);
  const [editCabsId, setEditCabsId] = useState(null); // userId для редактирования кабинетов
  const [err,        setErr]        = useState('');

  const saveProd = async p => {
    const updated = await api.updateProduct(p.id, { name: p.name, cost: +p.cost, comm: +p.comm, w: +p.w, d: +p.d, h: +p.h });
    setCatalog(c => c.map(x => x.id === p.id ? updated : x));
    setEditProd(null);
  };
  const addProd = async p => {
    const created = await api.addProduct({ name: p.name, cost: +p.cost, comm: +p.comm, w: +p.w, d: +p.d, h: +p.h });
    setCatalog(c => [...c, created]);
    setShowNew(false);
  };
  const delProd = async id => {
    await api.deleteProduct(id);
    setCatalog(c => c.filter(x => x.id !== id));
    setDelProdId(null);
  };
  const addCab = async () => {
    if (!newCab.trim()) return;
    try { const c = await api.addCab(newCab.trim()); setCabs(x => [...x, c]); setNewCab(''); }
    catch (e) { setErr(e.message); }
  };
  const delCab = async id => { await api.deleteCab(id); setCabs(x => x.filter(c => c.id !== id)); };
  const addUser = async () => {
    if (!newUser.login.trim() || !newUser.password.trim()) return;
    try {
      const u = await api.register(newUser.login.trim(), newUser.password, newUser.name);
      setUsers(x => [...x, u]);
      setNewUser({ login: '', password: '', name: '' });
      setAddingUser(false);
    } catch (e) { setErr(e.message); }
  };
  const delUser = async id => {
    try { await api.deleteUser(id); setUsers(x => x.filter(u => u.id !== id)); }
    catch (e) { setErr(e.message); }
  };

  const TABS = [{ k: 'products', l: '📦 Товары' }, { k: 'cabs', l: '🏢 Кабинеты' }, { k: 'users', l: '👥 Пользователи' }];

  return (
    <div className="fade-in">
      {editProd && <ProductModal prod={editProd} onSave={saveProd} onClose={() => setEditProd(null)} />}
      {showNew  && <ProductModal prod={{ name: '', cost: 0, comm: 25, w: 0, d: 0, h: 0 }} onSave={addProd} onClose={() => setShowNew(false)} />}
      {err && <div className="err-msg" style={{ marginBottom: 12 }}>{err}
        <button onClick={() => setErr('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', marginLeft: 8 }}>✕</button>
      </div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`btn ${tab === t.k ? 'btn-active' : ''}`}>{t.l}</button>
        ))}
      </div>

      {tab === 'products' && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <div className="section-header" style={{ marginBottom: 16 }}>
            <div>
              <div className="section-title">Справочник товаров</div>
              <div className="section-sub">{catalog.length} позиций</div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Добавить товар</button>
          </div>
          {delProdId && (
            <div className="confirm-bar">
              <span style={{ color: 'var(--red-txt)', flex: 1 }}>Удалить «{catalog.find(p => p.id === delProdId)?.name}»?</span>
              <button className="btn btn-danger" style={{ padding: '4px 14px' }} onClick={() => delProd(delProdId)}>Удалить</button>
              <button className="btn" style={{ padding: '4px 14px' }} onClick={() => setDelProdId(null)}>Отмена</button>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Название</th>
                <th>Себес. ₸</th><th>Комиссия</th>
                <th>Ш</th><th>Г</th><th>В</th><th>Объём л</th><th></th>
              </tr></thead>
              <tbody>
                {catalog.map(p => {
                  const vol = p.w && p.d && p.h ? ((+p.w * +p.d * +p.h) / 1000).toFixed(2) : '—';
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 500 }}>{p.name}</td>
                      <td style={{ textAlign: 'right' }}>{(+p.cost).toLocaleString('ru')}</td>
                      <td style={{ textAlign: 'right' }}><span className="badge badge-blue">{p.comm}%</span></td>
                      <td style={{ textAlign: 'center', color: 'var(--txt2)' }}>{p.w || '—'}</td>
                      <td style={{ textAlign: 'center', color: 'var(--txt2)' }}>{p.d || '—'}</td>
                      <td style={{ textAlign: 'center', color: 'var(--txt2)' }}>{p.h || '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--txt3)' }}>{vol}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn" style={{ padding: '4px 12px' }} onClick={() => setEditProd({ ...p })}>Изменить</button>
                          <button className="btn btn-danger" style={{ padding: '4px 12px' }} onClick={() => setDelProdId(p.id)}>Удалить</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'cabs' && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <div className="section-header" style={{ marginBottom: 16 }}>
            <div><div className="section-title">Кабинеты продавцов</div><div className="section-sub">{cabs.length} кабинетов</div></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <input className="form-input" value={newCab} onChange={e => setNewCab(e.target.value)}
              placeholder="Название нового кабинета" onKeyDown={e => e.key === 'Enter' && addCab()} style={{ flex: 1 }} />
            <button className="btn btn-primary" style={{ padding: '8px 20px', whiteSpace: 'nowrap' }} onClick={addCab}>+ Добавить</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {cabs.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                borderRadius: 20, padding: '6px 14px', fontSize: 13 }}>
                <span>{c.name}</span>
                <button onClick={() => delCab(c.id)} style={{ background: 'none', border: 'none',
                  cursor: 'pointer', color: 'var(--txt3)', fontSize: 16, lineHeight: 1, padding: 0 }}
                  onMouseEnter={e => e.target.style.color = 'var(--red-txt)'}
                  onMouseLeave={e => e.target.style.color = 'var(--txt3)'}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <div className="section-header" style={{ marginBottom: 16 }}>
            <div><div className="section-title">Пользователи</div><div className="section-sub">{users.length} аккаунтов</div></div>
            <button className="btn btn-primary" onClick={() => setAddingUser(v => !v)}>+ Добавить</button>
          </div>
          {addingUser && (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
              <div className="form-grid-3" style={{ marginBottom: 10 }}>
                {[['Логин', 'login', 'login'], ['Пароль', 'password', 'пароль'], ['Имя', 'name', 'Иван']].map(([l, k, ph]) => (
                  <div key={k}>
                    <label className="form-label">{l}</label>
                    <input className="form-input" value={newUser[k]} placeholder={ph}
                      type={k === 'password' ? 'password' : 'text'}
                      onChange={e => setNewUser(u => ({ ...u, [k]: e.target.value }))} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={addUser}>Создать</button>
                <button className="btn" onClick={() => setAddingUser(false)}>Отмена</button>
              </div>
            </div>
          )}

          {/* Модалка назначения кабинетов */}
          {editCabsId && (() => {
            const u = users.find(x => x.id === editCabsId);
            const current = u?.cab_ids || [];
            const toggle = async (cabId) => {
              const next = current.includes(cabId)
                ? current.filter(x => x !== cabId)
                : [...current, cabId];
              try {
                await api.setUserCabs(editCabsId, next);
                setUsers(us => us.map(x => x.id === editCabsId ? { ...x, cab_ids: next } : x));
              } catch (e) { setErr(e.message); }
            };
            return (
              <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditCabsId(null)}>
                <div className="modal" style={{ maxWidth: 400 }}>
                  <div className="modal-header">
                    <h2>Доступ к магазинам</h2>
                    <button className="modal-close" onClick={() => setEditCabsId(null)}>×</button>
                  </div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--txt2)' }}>
                    Сотрудник: <strong style={{ color: 'var(--txt)' }}>{u?.name || u?.login}</strong>
                  </div>
                  <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--txt3)' }}>
                    Выберите магазины, к которым у сотрудника будет доступ:
                  </div>
                  {allCabs.length === 0 ? (
                    <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Нет кабинетов. Сначала создайте в разделе «Кабинеты».</div>
                  ) : allCabs.map(c => {
                    const checked = current.includes(c.id);
                    return (
                      <label key={c.id} onClick={() => toggle(c.id)} style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                        marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                        background: checked ? 'var(--blue-bg)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${checked ? 'rgba(79,124,255,0.35)' : 'var(--border)'}`,
                        transition: 'all 0.15s',
                      }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                          border: `2px solid ${checked ? 'var(--blue)' : 'var(--border)'}`,
                          background: checked ? 'var(--blue)' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, color: '#fff', fontWeight: 700,
                        }}>{checked ? '✓' : ''}</div>
                        <span style={{ fontSize: 13, fontWeight: checked ? 600 : 400 }}>{c.name}</span>
                      </label>
                    );
                  })}
                  <button className="btn btn-primary btn-full" style={{ marginTop: 16 }}
                    onClick={() => setEditCabsId(null)}>Готово</button>
                </div>
              </div>
            );
          })()}

          <table>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>Пользователь</th>
              <th style={{ textAlign: 'left' }}>Логин</th>
              <th>Роль</th>
              <th>Магазины</th>
              <th></th>
            </tr></thead>
            <tbody>
              {users.map(u => {
                const userCabNames = (u.cab_ids || [])
                  .map(id => allCabs.find(c => c.id === id)?.name)
                  .filter(Boolean);
                return (
                  <tr key={u.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>{initials(u.name || u.login)}</div>
                        <span style={{ fontWeight: 500 }}>{u.name || '—'}</span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--txt2)', fontSize: 12 }}>{u.login}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={`badge ${u.role === 'admin' ? 'badge-blue' : ''}`}
                        style={u.role !== 'admin' ? { color: 'var(--txt3)' } : {}}>
                        {u.role === 'admin' ? 'Администратор' : 'Сотрудник'}
                      </span>
                    </td>
                    <td>
                      {u.role === 'admin' ? (
                        <span style={{ fontSize: 11, color: 'var(--green-txt)' }}>Все магазины</span>
                      ) : userCabNames.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {userCabNames.map(n => (
                            <span key={n} className="badge" style={{ fontSize: 10, background: 'rgba(255,255,255,0.06)' }}>{n}</span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--red-txt)' }}>Нет доступа</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {u.role !== 'admin' && (
                          <button className="btn" style={{ padding: '3px 12px', fontSize: 11 }}
                            onClick={() => setEditCabsId(u.id)}>🏢 Магазины</button>
                        )}
                        <button className="btn btn-danger" style={{ padding: '3px 12px', fontSize: 11 }}
                          onClick={() => delUser(u.id)}>Удалить</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Дашборд компании ──────────────────────────────────────────────────────────
function CompanyDashboard({ history, users, cabs }) {
  const [period,     setPeriod]     = useState('month');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [filterUser, setFilterUser] = useState('all');
  const [filterCab,  setFilterCab]  = useState('all');

  const filtered = useMemo(() => {
    let h = history;
    if (filterUser !== 'all') h = h.filter(r => r.user_login === filterUser);
    if (filterCab  !== 'all') h = h.filter(r => r.cabinet    === filterCab);
    return filterByRange(h, 'date', { period, dateFrom, dateTo });
  }, [history, period, dateFrom, dateTo, filterUser, filterCab]);

  const total = useMemo(() => {
    if (!filtered.length) return null;
    const sum = f => filtered.reduce((a, r) => a + (parseFloat(r[f]) || 0), 0);
    const rev = sum('rev'), profit = sum('profit'), ads = sum('ads'),
          cost = sum('cost'), comm = sum('comm'), log_f = sum('log_f'), log_r = sum('log_r'), ret = sum('ret');
    return { rev, profit, ads, cost, comm, log_f, log_r, ret,
      margin: rev > 0 ? profit / rev * 100 : 0,
      drr:    rev > 0 ? ads / rev * 100 : 0,
      days:   filtered.length };
  }, [filtered]);

  const byUser = useMemo(() => {
    const map = {};
    filtered.forEach(r => {
      const k = r.user_login || '—';
      if (!map[k]) map[k] = { rev: 0, profit: 0, ads: 0, cost: 0, comm: 0, log_f: 0, log_r: 0, ret: 0, cnt: 0 };
      const m = map[k];
      ['rev','profit','ads','cost','comm','log_f','log_r','ret'].forEach(f => m[f] += parseFloat(r[f]) || 0);
      m.cnt++;
    });
    return Object.entries(map).map(([login, m]) => {
      const u = users.find(u => u.login === login);
      return { ...m, login, name: u?.name || login,
        margin: m.rev > 0 ? m.profit / m.rev * 100 : 0,
        drr:    m.rev > 0 ? m.ads / m.rev * 100 : 0 };
    }).sort((a, b) => b.rev - a.rev);
  }, [filtered, users]);

  const userLogins = [...new Set(history.map(r => r.user_login).filter(Boolean))];
  const totalExp = total ? total.cost + total.ads + total.comm + total.log_f + total.log_r + total.ret : 0;

  return (
    <div className="fade-in">
      {/* Лучшие сотрудники */}
      <TopEmployees history={history} users={users} />

      {/* Фильтры */}
      <FilterBar period={period} setPeriod={setPeriod}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo}
        cabinet={filterCab} setCabinet={setFilterCab}
        cabinets={cabs} showCabFilter />

      {/* Фильтр по сотруднику */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[{ v: 'all', l: 'Все сотрудники' }, ...userLogins.map(l => {
          const u = users.find(u => u.login === l);
          return { v: l, l: u?.name || l };
        })].map(o => (
          <button key={o.v} onClick={() => setFilterUser(o.v)}
            className={`pill ${filterUser === o.v ? 'active' : ''}`}>{o.l}</button>
        ))}
      </div>

      {!total ? (
        <div className="card"><div className="empty"><div className="empty-icon">📊</div>Нет данных за выбранный период</div></div>
      ) : (<>
        <div className="kpi-grid">
          {[
            { l: 'Общая выручка',  v: fmt(total.rev) + ' ₸',    type: 'rev',    val: 1 },
            { l: 'Чистая прибыль', v: fmt(total.profit) + ' ₸', type: 'profit', val: total.profit },
            { l: 'Маржа',          v: fmtP(total.margin) + '%', type: 'margin', val: total.margin },
            { l: 'ДРР',            v: fmtP(total.drr) + '%',    type: 'drr',    val: total.drr },
          ].map(k => (
            <div key={k.l} className="kpi-card">
              <div className="kpi-label">{k.l}</div>
              <div className="kpi-value" style={{ color: kpiColor(k.type, k.val) }}>{k.v}</div>
              <div className="kpi-sub">{total.days} записей</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div className="card" style={{ padding: '20px 24px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Структура расходов</div>
            {[
              { l: 'Себестоимость',       v: total.cost,  col: 'var(--red-txt)' },
              { l: 'Реклама',             v: total.ads,   col: 'var(--yellow-txt)' },
              { l: 'Комиссия WB',         v: total.comm,  col: 'var(--red-txt)' },
              { l: 'Логистика доставки',  v: total.log_f, col: 'var(--txt2)' },
              { l: 'Логистика возвратов', v: total.log_r, col: 'var(--txt2)' },
              { l: 'Потери на возвраты',  v: total.ret,   col: 'var(--red-txt)' },
            ].map(r => {
              const pct = totalExp > 0 ? r.v / totalExp * 100 : 0;
              return (
                <div key={r.l} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                    <span style={{ color: 'var(--txt2)' }}>{r.l}</span>
                    <span style={{ color: r.col, fontWeight: 600 }}>
                      −{fmt(r.v)} ₸ <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--txt3)' }}>{pct.toFixed(0)}%</span>
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: pct + '%', background: r.col, opacity: 0.7 }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ padding: '20px 24px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Итог за период</div>
            {[
              { l: 'Выручка',     v: '+' + fmt(total.rev) + ' ₸',  col: 'var(--blue-txt)' },
              { l: 'Все расходы', v: '−' + fmt(totalExp) + ' ₸',   col: 'var(--red-txt)' },
              { l: 'Реклама',     v: '−' + fmt(total.ads) + ' ₸',  col: 'var(--yellow-txt)' },
            ].map(r => (
              <div key={r.l} className="result-row">
                <span style={{ color: 'var(--txt2)', fontSize: 13 }}>{r.l}</span>
                <span style={{ color: r.col, fontWeight: 600 }}>{r.v}</span>
              </div>
            ))}
            <div style={{ padding: '16px 0 0', marginTop: 8, borderTop: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800,
              color: kpiColor('profit', total.profit), letterSpacing: '-0.02em' }}>
              <span>Прибыль</span>
              <span>{fmt(total.profit)} ₸</span>
            </div>
          </div>
        </div>

        {byUser.length > 1 && (
          <div className="card" style={{ padding: '20px 24px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}>По сотрудникам</div>
            <table>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Сотрудник</th>
                <th>Записей</th><th>Выручка</th><th>Расходы</th><th>Прибыль</th><th>Маржа</th><th>ДРР</th>
              </tr></thead>
              <tbody>
                {byUser.map(u => (
                  <tr key={u.login}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>{initials(u.name)}</div>
                        <span style={{ fontWeight: 500 }}>{u.name}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'center', color: 'var(--txt2)' }}>{u.cnt}</td>
                    <td style={{ textAlign: 'right', color: 'var(--blue-txt)', fontWeight: 600 }}>{fmt(u.rev)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red-txt)' }}>
                      {fmt(u.cost + u.ads + u.comm + u.log_f + u.log_r + u.ret)}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: kpiColor('profit', u.profit) }}>{fmt(u.profit)}</td>
                    <td style={{ textAlign: 'right', color: kpiColor('margin', u.margin) }}>{fmtP(u.margin)}%</td>
                    <td style={{ textAlign: 'right', color: kpiColor('drr', u.drr) }}>{fmtP(u.drr)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>)}
    </div>
  );
}

// ── История ───────────────────────────────────────────────────────────────────
function HistoryPanel({ history, users, cabs, isAdmin, userLogin, onDelete, onClear }) {
  const [period,     setPeriod]     = useState('month');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [filterCab,  setFilterCab]  = useState('all');
  const [delConfirm, setDelConfirm] = useState(null);

  const visible = isAdmin ? history : history.filter(h => h.user_login === userLogin);

  const filtered = useMemo(() => {
    let h = visible;
    if (filterCab !== 'all') h = h.filter(r => r.cabinet === filterCab);
    return filterByRange(h, 'date', { period, dateFrom, dateTo });
  }, [visible, period, dateFrom, dateTo, filterCab]);

  const summary = useMemo(() => {
    if (!filtered.length) return null;
    const sum = f => filtered.reduce((a, r) => a + (parseFloat(r[f]) || 0), 0);
    const rev = sum('rev'), profit = sum('profit'), ads = sum('ads'),
          cost = sum('cost'), comm = sum('comm'), log_f = sum('log_f'), log_r = sum('log_r'), ret = sum('ret');
    return { rev, profit, ads, cost, comm, log_f, log_r, ret,
      margin: rev > 0 ? profit / rev * 100 : 0,
      drr: rev > 0 ? ads / rev * 100 : 0, count: filtered.length };
  }, [filtered]);

  return (
    <div className="fade-in">
      <FilterBar period={period} setPeriod={setPeriod}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo}
        cabinet={filterCab} setCabinet={setFilterCab}
        cabinets={cabs} showCabFilter />

      {isAdmin && visible.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-danger" onClick={() => setDelConfirm('all')}>Очистить всю историю</button>
        </div>
      )}

      {summary && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          {[
            { l: 'Выручка', v: fmt(summary.rev) + ' ₸',    col: 'var(--blue-txt)' },
            { l: 'Расходы', v: fmt(summary.cost + summary.ads + summary.comm + summary.log_f + summary.log_r + summary.ret) + ' ₸', col: 'var(--red-txt)' },
            { l: 'Прибыль', v: fmt(summary.profit) + ' ₸', col: kpiColor('profit', summary.profit) },
            { l: 'Маржа',   v: fmtP(summary.margin) + '%', col: kpiColor('margin', summary.margin) },
          ].map(k => (
            <div key={k.l} className="kpi-card">
              <div className="kpi-label">{k.l}</div>
              <div className="kpi-value" style={{ color: k.col, fontSize: 18 }}>{k.v}</div>
              <div className="kpi-sub">{summary.count} записей</div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: '20px 24px' }}>
        {delConfirm && (
          <div className="confirm-bar">
            <span style={{ color: 'var(--red-txt)', flex: 1 }}>
              {delConfirm === 'all' ? 'Удалить всю историю?' : 'Удалить эту запись?'}
            </span>
            <button className="btn btn-danger" style={{ padding: '4px 14px' }}
              onClick={delConfirm === 'all'
                ? async () => { await onClear(); setDelConfirm(null); }
                : async () => { await onDelete(delConfirm); setDelConfirm(null); }}>
              Да, удалить
            </button>
            <button className="btn" style={{ padding: '4px 14px' }} onClick={() => setDelConfirm(null)}>Отмена</button>
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🗂</div>
            {visible.length === 0 ? 'Нет записей — заполни форму и нажми «Сохранить»' : 'Нет записей за выбранный период'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Дата</th>
                <th style={{ textAlign: 'left' }}>Кабинет</th>
                {isAdmin && <th style={{ textAlign: 'left' }}>Сотрудник</th>}
                <th>Выручка</th><th>Себес.</th><th>Реклама</th><th>Комиссия</th>
                <th>Логистика</th><th>Возвраты</th><th>Прибыль</th><th>Маржа</th><th>ДРР</th>
                {isAdmin && <th></th>}
              </tr></thead>
              <tbody>
                {filtered.map(h => (
                  <tr key={h.id}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--txt2)', fontSize: 12 }}>{h.date?.split('T')[0] || h.date}</td>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{h.cabinet}</td>
                    {isAdmin && (
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div className="avatar" style={{ width: 22, height: 22, fontSize: 9 }}>
                            {initials(users.find(u => u.login === h.user_login)?.name || h.user_login || '?')}
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{h.user_login || '—'}</span>
                        </div>
                      </td>
                    )}
                    <td style={{ textAlign: 'right', color: 'var(--blue-txt)', fontWeight: 600 }}>{fmt(h.rev)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red-txt)' }}>{fmt(h.cost)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--yellow-txt)' }}>{fmt(h.ads)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red-txt)' }}>{fmt(h.comm)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--txt2)' }}>{fmt(parseFloat(h.log_f) + parseFloat(h.log_r))}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red-txt)' }}>{fmt(h.ret)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: kpiColor('profit', parseFloat(h.profit)) }}>{fmt(h.profit)}</td>
                    <td style={{ textAlign: 'right', color: kpiColor('margin', parseFloat(h.margin)) }}>{fmtP(parseFloat(h.margin))}%</td>
                    <td style={{ textAlign: 'right', color: kpiColor('drr', parseFloat(h.drr)) }}>{fmtP(parseFloat(h.drr))}%</td>
                    {isAdmin && (
                      <td style={{ textAlign: 'right' }}>
                        <button onClick={() => setDelConfirm(h.id)} style={{ background: 'none', border: 'none',
                          cursor: 'pointer', color: 'var(--txt3)', fontSize: 16, padding: '0 4px' }}
                          onMouseEnter={e => e.target.style.color = 'var(--red-txt)'}
                          onMouseLeave={e => e.target.style.color = 'var(--txt3)'}>×</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Главный компонент ─────────────────────────────────────────────────────────
export default function App() {
  const [user,    setUser]    = useState(null);
  const [users,   setUsers]   = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [cabs,    setCabs]    = useState([]);   // кабинеты текущего пользователя
  const [allCabs, setAllCabs] = useState([]);   // все кабинеты (для админа)
  const [history, setHist]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [appTab,  setAppTab]  = useState('calc');

  const [exRate,     setExRate]   = useState(6.74);
  const [rateDate,   setRateDate] = useState('—');
  const [rateStatus, setRStatus]  = useState('idle');
  const [editRate,   setEditRate] = useState(false);
  const [editVal,    setEditVal]  = useState('6.74');
  const [coeff,      setCoeff]    = useState(1.95);
  const [retRate,    setRet]      = useState(88);
  const [date,       setDate]     = useState(toDay());
  const [cabinet,    setCab]      = useState('');
  const [revenue,    setRev]      = useState('');
  // реклама хранится в рублях, конвертируется в тенге при расчёте
  const [adsRub,     setAdsRub]   = useState('');
  const [rows,       setRows]     = useState([]);
  const [saved,      setSaved]    = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([api.getCatalog(), api.getCabs(), api.getHistory(), api.getUsers()])
      .then(([cat, cabList, hist, userList]) => {
        setCatalog(cat);
        setAllCabs(cabList);
        setHist(hist);
        setUsers(userList);
        // Сотрудник видит только назначенные ему кабинеты
        const visibleCabs = user?.role === 'admin' ? cabList
          : cabList.filter(c => (user?.cab_ids || []).includes(c.id));
        setCabs(visibleCabs);
        const firstCab = visibleCabs[0] || (user?.role === 'admin' ? cabList[0] : null);
        if (firstCab) setCab(firstCab.name);
        if (cat.length) setRows([mkRow(cat[0])]);
        fetchRate();
      })
      .finally(() => setLoading(false));
  }, [user]);

  const mkRow = prod => ({ id: Date.now() + Math.random(), product: prod.name, qty: '', cost: prod.cost, comm: prod.comm });
  const addRow = () => { if (catalog.length) setRows(r => [...r, mkRow(catalog[0])]); };

  const fetchRate = async () => {
    setRStatus('loading');
    try {
      const res = await fetch('/api/rate');
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      if (data.rate) {
        setExRate(data.rate);
        setEditVal(String(data.rate));
        setRateDate(new Date(data.date).toLocaleDateString('ru'));
        setRStatus('ok');
      } else throw new Error(data.error || 'no rate');
    } catch { setRStatus('error'); }
  };

  const updateRow = (id, field, val) => {
    setRows(r => r.map(row => {
      if (row.id !== id) return row;
      if (field === 'product') {
        const p = catalog.find(p => p.name === val) || catalog[0];
        return { ...row, product: val, cost: p?.cost ?? 0, comm: p?.comm ?? 25 };
      }
      return { ...row, [field]: val };
    }));
  };

  // реклама в тенге = рубли × курс
  const adsKzt = num(adsRub) * exRate;

  const calc = useMemo(() => {
    const rev = num(revenue), adsN = adsKzt, buyout = retRate / 100;
    let cost = 0, comm = 0, logF = 0, totalQty = 0;
    rows.forEach(row => {
      const qty = num(row.qty), c = num(row.cost), k = num(row.comm) / 100;
      const prod = catalog.find(p => p.name === row.product) || {};
      const lr = logRub(prod.w, prod.d, prod.h);
      cost += qty * c; comm += qty * c * k;
      logF += lr !== null ? qty * (lr * coeff / buyout) * exRate : 0;
      totalQty += qty;
    });
    if (!cost && rev) comm = rev * 0.25;
    const ret  = rev * (1 - buyout);
    const logR = totalQty * ((1 - buyout) / buyout) * 50 * coeff * exRate;
    const profit = rev - cost - adsN - comm - logF - logR - ret;
    return { rev, ads: adsN, adsRub: num(adsRub), cost, comm, logF, logR, ret, profit,
      margin: rev > 0 ? profit / rev * 100 : 0,
      drr: rev > 0 ? adsN / rev * 100 : 0 };
  }, [revenue, adsKzt, adsRub, rows, exRate, coeff, retRate, catalog]);

  const save = async () => {
    if (!calc.rev) { alert('Введи выручку'); return; }
    try {
      const rec = await api.addHistory({
        date, cabinet, user_login: user.login,
        rev: calc.rev, ads: calc.ads, cost: calc.cost, comm: calc.comm,
        log_f: calc.logF, log_r: calc.logR, ret: calc.ret,
        profit: calc.profit, margin: calc.margin, drr: calc.drr,
      });
      setHist(h => [rec, ...h]);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { alert('Ошибка: ' + e.message); }
  };

  const isAdmin = user?.role === 'admin';
  const NAV = [
    { k: 'calc',    l: 'Калькулятор' },
    { k: 'history', l: 'История' },
    { k: 'company', l: 'Компания' },
    ...(isAdmin ? [{ k: 'admin', l: 'Администратор' }] : []),
  ];

  if (!user) return <LoginScreen onLogin={setUser} />;
  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      Загрузка данных...
    </div>
  );

  return (
    <div className="app-layout">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-logo">
            <div className="topbar-logo-dot" />
            WB Analytics
          </div>
          <nav className="topbar-nav">
            {NAV.map(t => (
              <button key={t.k} className={`nav-btn ${appTab === t.k ? 'active' : ''}`}
                onClick={() => setAppTab(t.k)}>{t.l}</button>
            ))}
          </nav>
          <div className="topbar-user">
            <div className="avatar">{initials(user.name || user.login)}</div>
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{user.name || user.login}</div>
              {isAdmin && <span className="badge badge-blue" style={{ fontSize: 10 }}>admin</span>}
            </div>
            <button className="logout-btn" onClick={() => { setUser(null); setRows([]); setAppTab('calc'); }}>Выйти</button>
          </div>
        </div>
      </header>

      <div className="app-content">

        {/* ── Калькулятор ── */}
        {appTab === 'calc' && (
          <div className="fade-in">
            {/* Курс + Настройки */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div className="rate-bar">
                <span style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Курс НБК</span>
                {rateStatus === 'loading' && (
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', color: 'var(--blue-txt)' }}>⟳</span>
                )}
                {rateStatus === 'ok' && !editRate && (
                  <>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--green-txt)' }}>1 ₽ = {exRate.toFixed(3)} ₸</span>
                    <span className="badge badge-green" style={{ fontSize: 10 }}>{rateDate}</span>
                  </>
                )}
                {rateStatus === 'error' && <span style={{ fontSize: 12, color: 'var(--red-txt)' }}>Не удалось загрузить</span>}
                {editRate ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="number" value={editVal} step="0.001" className="form-input" style={{ width: 90, fontSize: 13 }}
                      onChange={e => setEditVal(e.target.value)} />
                    <button className="btn btn-primary" style={{ padding: '5px 12px' }} onClick={() => {
                      const v = parseFloat(editVal); if (v > 0) { setExRate(v); setRateDate('вручную'); } setEditRate(false);
                    }}>OK</button>
                  </div>
                ) : (
                  <button className="btn" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setEditRate(true)}>Изменить</button>
                )}
                <button className="btn" style={{ marginLeft: 'auto', fontSize: 11, opacity: rateStatus === 'loading' ? 0.5 : 1 }}
                  disabled={rateStatus === 'loading'} onClick={fetchRate}>⟳ Обновить</button>
              </div>

              {isAdmin ? (
                <div className="card" style={{ padding: '10px 16px', display: 'flex', gap: 20, alignItems: 'center' }}>
                  {[{ l: 'Коэф. склада', v: coeff, s: setCoeff, min: 1, max: 5, step: 0.05 },
                    { l: 'Выкуп, %', v: retRate, s: setRet, min: 0, max: 100, step: 1 }].map(x => (
                    <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{x.l}</span>
                      <input type="number" value={x.v} min={x.min} max={x.max} step={x.step}
                        className="form-input" style={{ width: 72 }}
                        onChange={e => x.s(parseFloat(e.target.value) || 0)} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card" style={{ padding: '10px 16px', display: 'flex', gap: 16, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--txt3)' }}>Коэф. склада:</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{coeff}</span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', marginLeft: 8 }}>Выкуп:</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{retRate}%</span>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Форма */}
              <div>
                <div className="card" style={{ padding: '20px 24px', marginBottom: 12 }}>
                  <div className="section-title" style={{ marginBottom: 16 }}>Основные данные</div>
                  <div className="form-grid-2" style={{ marginBottom: 12 }}>
                    <div>
                      <label className="form-label">Дата</label>
                      <input type="date" value={date} onChange={e => setDate(e.target.value)} className="form-input" />
                    </div>
                    <div>
                      <label className="form-label">Кабинет</label>
                      <select value={cabinet} onChange={e => setCab(e.target.value)} className="form-input">
                        {cabs.map(c => <option key={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="form-grid-2">
                    <div>
                      <label className="form-label">Выручка, ₸</label>
                      <input type="number" value={revenue} placeholder="0"
                        onChange={e => setRev(e.target.value)} className="form-input" />
                    </div>
                    <div>
                      <label className="form-label">
                        Реклама, ₽
                        {num(adsRub) > 0 && (
                          <span style={{ marginLeft: 6, color: 'var(--yellow-txt)', fontWeight: 400 }}>
                            = {fmt(adsKzt)} ₸
                          </span>
                        )}
                      </label>
                      <input type="number" value={adsRub} placeholder="0 ₽"
                        onChange={e => setAdsRub(e.target.value)} className="form-input" />
                    </div>
                  </div>
                </div>

                <div className="card" style={{ padding: '20px 24px' }}>
                  <div className="section-title" style={{ marginBottom: 12 }}>Товары</div>
                  <div className="prod-row" style={{ marginBottom: 6, gridTemplateColumns: isAdmin ? '1fr 60px 90px 60px 60px 90px 32px' : '1fr 80px 60px 90px 32px' }}>
                    {(isAdmin
                      ? ['Товар', 'Кол.', 'Себес. ₸', 'Ком.', '₸/шт', 'Лог. итого', '']
                      : ['Товар', 'Кол.', '₸/шт', 'Лог. итого', '']
                    ).map((h, i) => (
                      <span key={i} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                        letterSpacing: '0.05em', color: 'var(--txt3)',
                        textAlign: i === 0 ? 'left' : 'center' }}>{h}</span>
                    ))}
                  </div>
                  {rows.map(r => (
                    <ProdRow key={r.id} row={r} catalog={catalog} rate={exRate} coeff={coeff} isAdmin={isAdmin}
                      onUpdate={updateRow} onDel={id => setRows(r => r.filter(x => x.id !== id))} />
                  ))}
                  <button className="btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={addRow}>
                    + Добавить товар
                  </button>
                </div>
              </div>

              {/* Результат */}
              <div>
                <ResultPanel c={calc} />
                <button onClick={save} className={`btn btn-lg btn-full ${saved ? 'btn-success' : 'btn-primary'}`}
                  style={{ marginTop: 10, transition: 'all 0.2s' }}>
                  {saved ? '✓ Сохранено!' : '💾 Сохранить запись'}
                </button>
              </div>
            </div>
          </div>
        )}

        {appTab === 'history' && (
          <HistoryPanel
            history={history} users={users} cabs={cabs}
            isAdmin={isAdmin} userLogin={user.login}
            onDelete={async id => { await api.deleteRecord(id); setHist(h => h.filter(r => r.id !== id)); }}
            onClear={async () => { await api.clearHistory(); setHist([]); }}
          />
        )}

        {appTab === 'company' && <CompanyDashboard history={history} users={users} cabs={cabs} />}

        {appTab === 'admin' && isAdmin && (
          <AdminPanel catalog={catalog} setCatalog={setCatalog}
            cabs={allCabs} setCabs={cab => { setAllCabs(cab); setCabs(cab); }}
            users={users} setUsers={setUsers} allCabs={allCabs} />
        )}
      </div>
    </div>
  );
}
