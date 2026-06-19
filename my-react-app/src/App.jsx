import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { api } from "./api";
import * as XLSX from "xlsx";

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

// ── Анимация чисел ────────────────────────────────────────────────────────────
function useCountUp(target, duration = 600) {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const start = prev.current;
    const diff  = target - start;
    if (!diff) return;
    const startTime = performance.now();
    const tick = (now) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(start + diff * eased);
      if (t < 1) requestAnimationFrame(tick);
      else { setVal(target); prev.current = target; }
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return val;
}

// Анимированное KPI значение (только для числовых, денежных)
function AnimatedKpi({ value, format = 'money', color }) {
  const animated = useCountUp(value);
  const display = format === 'money'
    ? fmt(animated) + ' ₸'
    : format === 'pct'
    ? fmtP(animated) + '%'
    : fmt(animated);
  return <span style={{ color }}>{display}</span>;
}

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
    try {
      const u = await api.login(login.trim(), pass);
      localStorage.setItem('wb_user', JSON.stringify(u));
      onLogin(u);
    }
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
    <div className="prod-row" style={{ gridTemplateColumns: isAdmin ? '1fr 60px 90px 60px 60px 90px 32px' : '1fr 80px 32px' }}>
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
      {isAdmin && (
        <div style={{ textAlign: 'center', fontSize: 11, color: lKzt === null ? 'var(--yellow-txt)' : 'var(--txt2)' }}>
          {lKzt === null ? '—' : Math.round(lKzt)}
        </div>
      )}
      {isAdmin && (
        <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>
          {lKzt === null ? '—' : fmt(qty * (lKzt ?? 0)) + ' ₸'}
        </div>
      )}
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
function GoalInput({ userId, month, current, onSave }) {
  const [val, setVal] = useState(current ? String(current) : '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setVal(current ? String(current) : ''); }, [current]);

  const save = async () => {
    const goal = parseFloat(String(val).replace(/\s/g, '')) || 0;
    if (goal === current) return;
    setSaving(true);
    try {
      await api.setUserGoal(userId, month, goal);
      onSave(goal);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
      <input
        type="number" min="0" step="1000000"
        value={val} onChange={e => setVal(e.target.value)}
        onBlur={save} onKeyDown={e => e.key === 'Enter' && save()}
        className="form-input"
        style={{ width: 110, textAlign: 'right', fontSize: 12,
          borderColor: saved ? 'var(--green)' : undefined }}
        placeholder="0 ₸"
      />
      {saving && <span style={{ fontSize: 10, color: 'var(--txt3)' }}>…</span>}
      {saved  && <span style={{ fontSize: 12, color: 'var(--green-txt)' }}>✓</span>}
    </div>
  );
}

function SalaryInput({ userId, current, setUsers }) {
  const [val, setVal] = useState(current ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const pct = parseFloat(val);
    if (isNaN(pct) || pct < 0 || pct > 100) return;
    setSaving(true);
    try {
      await api.setSalary(userId, pct);
      setUsers(us => us.map(u => u.id === userId ? { ...u, salary_pct: pct } : u));
    } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
      <input
        type="number" min="0" max="100" step="0.5"
        value={val} onChange={e => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={e => e.key === 'Enter' && save()}
        placeholder="0"
        style={{ width: 52, textAlign: 'center', fontSize: 12,
          background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 6px', color: 'var(--txt)', outline: 'none' }}
      />
      <span style={{ fontSize: 11, color: 'var(--txt3)' }}>%</span>
      {saving && <span style={{ fontSize: 10, color: 'var(--blue-txt)' }}>...</span>}
    </div>
  );
}

function AdminPanel({ catalog, setCatalog, cabs, setCabs, users, setUsers, allCabs, userGoals, setUserGoals, history }) {
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
  const [newCabBuyout, setNewCabBuyout] = useState(88);
  const [editCab, setEditCab] = useState(null); // {id, name, buyout}

  const addCab = async () => {
    if (!newCab.trim()) return;
    try {
      const c = await api.addCab(newCab.trim(), newCabBuyout);
      setCabs(x => [...x, c]);
      setNewCab(''); setNewCabBuyout(88);
    } catch (e) { setErr(e.message); }
  };
  const saveCab = async () => {
    if (!editCab) return;
    try {
      const c = await api.updateCab(editCab.id, { name: editCab.name, buyout: +editCab.buyout });
      setCabs(x => x.map(cab => cab.id === c.id ? c : cab));
      setEditCab(null);
    } catch (e) { setErr(e.message); }
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

          {/* Модалка редактирования кабинета */}
          {editCab && (
            <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditCab(null)}>
              <div className="modal" style={{ maxWidth: 360 }}>
                <div className="modal-header">
                  <h2>Редактировать кабинет</h2>
                  <button className="modal-close" onClick={() => setEditCab(null)}>×</button>
                </div>
                <div className="field" style={{ marginBottom: 14 }}>
                  <label className="form-label">Название</label>
                  <input className="form-input" value={editCab.name}
                    onChange={e => setEditCab(x => ({ ...x, name: e.target.value }))} />
                </div>
                <div className="field" style={{ marginBottom: 20 }}>
                  <label className="form-label">Процент выкупа, %</label>
                  <input type="number" className="form-input" value={editCab.buyout} min="0" max="100"
                    onChange={e => setEditCab(x => ({ ...x, buyout: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={saveCab}>Сохранить</button>
                  <button className="btn btn-lg" onClick={() => setEditCab(null)}>Отмена</button>
                </div>
              </div>
            </div>
          )}

          {/* Добавить новый */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <input className="form-input" value={newCab} onChange={e => setNewCab(e.target.value)}
              placeholder="Название кабинета" onKeyDown={e => e.key === 'Enter' && addCab()} style={{ flex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>Выкуп %</span>
              <input type="number" className="form-input" value={newCabBuyout} min="0" max="100"
                onChange={e => setNewCabBuyout(+e.target.value)} style={{ width: 70 }} />
            </div>
            <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={addCab}>+ Добавить</button>
          </div>

          {/* Список */}
          <table>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>Кабинет</th>
              <th style={{ textAlign: 'center' }}>Выкуп %</th>
              <th></th>
            </tr></thead>
            <tbody>
              {cabs.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>{c.name}</td>
                  <td style={{ textAlign: 'center' }}>
                    <span className="badge" style={{
                      background: +c.buyout >= 85 ? 'var(--green-bg)' : +c.buyout >= 70 ? 'var(--yellow-bg)' : 'var(--red-bg)',
                      color:      +c.buyout >= 85 ? 'var(--green-txt)' : +c.buyout >= 70 ? 'var(--yellow-txt)' : 'var(--red-txt)',
                    }}>{c.buyout ?? 88}%</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn" style={{ padding: '3px 12px', fontSize: 11 }}
                        onClick={() => setEditCab({ id: c.id, name: c.name, buyout: c.buyout ?? 88 })}>
                        Изменить
                      </button>
                      <button className="btn btn-danger" style={{ padding: '3px 12px', fontSize: 11 }}
                        onClick={() => delCab(c.id)}>Удалить</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

          {/* Блок трекера планов */}
          {(() => {
            const curMonth = new Date().toISOString().slice(0, 7);
            const usersWithGoals = users.filter(u => {
              const g = userGoals?.find(x => x.user_id === u.id && x.month === curMonth);
              return g && +g.goal > 0;
            });
            if (!usersWithGoals.length) return null;
            return (
              <div className="card" style={{ padding: '16px 20px', marginBottom: 16 }}>
                <div className="section-title" style={{ marginBottom: 12 }}>
                  📊 Выполнение планов — {curMonth}
                </div>
                {usersWithGoals.map(u => {
                  const g = userGoals.find(x => x.user_id === u.id && x.month === curMonth);
                  const status = calcPlanStatus(+g.goal, history, u.login, curMonth);
                  if (!status) return null;
                  const { actual, goal: gv, expectedByToday, delta, deltaPct, progressPct, daysPassed, daysLeft, forecast } = status;
                  const ahead = delta >= 0;
                  return (
                    <div key={u.id} style={{ marginBottom: 16, paddingBottom: 16,
                      borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{initials(u.name || u.login)}</div>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{u.name || u.login}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 16, fontSize: 12, alignItems: 'center' }}>
                          <span style={{ color: 'var(--txt3)' }}>День {daysPassed} · осталось {daysLeft} дн.</span>
                          <span style={{ color: 'var(--blue-txt)', fontWeight: 600 }}>{fmt(actual)} ₸</span>
                          <span style={{ color: ahead ? 'var(--green-txt)' : 'var(--red-txt)', fontWeight: 700 }}>
                            {ahead ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}%
                            <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
                              ({ahead ? '+' : '−'}{fmt(Math.abs(delta))} ₸)
                            </span>
                          </span>
                        </div>
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{
                          width: progressPct + '%',
                          background: progressPct >= 100 ? 'var(--green-txt)' : ahead ? 'var(--blue)' : 'var(--yellow-txt)',
                        }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--txt3)', marginTop: 4 }}>
                        <span>Факт: {fmt(actual)} из {fmt(gv)} ₸ ({progressPct.toFixed(1)}%)</span>
                        <span>Ожидалось к сегодня: {fmt(expectedByToday)} ₸</span>
                        <span>Прогноз к концу месяца: <b style={{ color: forecast >= gv ? 'var(--green-txt)' : 'var(--yellow-txt)' }}>{fmt(forecast)} ₸</b></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <table>
            <thead><tr>
              <th style={{ textAlign: 'left' }}>Пользователь</th>
              <th style={{ textAlign: 'left' }}>Логин</th>
              <th>Роль</th>
              <th>Магазины</th>
              <th>% ЗП</th>
              <th style={{ textAlign: 'center' }}>🎯 План/мес ₸</th>
              <th></th>
            </tr></thead>
            <tbody>
              {users.map(u => {
                const curMonth = new Date().toISOString().slice(0, 7);
                const userCabNames = (u.cab_ids || [])
                  .map(id => allCabs.find(c => c.id === id)?.name)
                  .filter(Boolean);
                const existingGoal = userGoals?.find(x => x.user_id === u.id && x.month === curMonth);
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
                    <td style={{ textAlign: 'center' }}>
                      <SalaryInput userId={u.id} current={u.salary_pct} setUsers={setUsers} />
                    </td>
                    <td style={{ textAlign: 'center', minWidth: 140 }}>
                      <GoalInput
                        userId={u.id}
                        month={curMonth}
                        current={existingGoal ? +existingGoal.goal : 0}
                        onSave={(goal) => {
                          setUserGoals(gs => {
                            const without = (gs || []).filter(x => !(x.user_id === u.id && x.month === curMonth));
                            return [...without, { user_id: u.id, month: curMonth, goal }];
                          });
                        }}
                      />
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
function CompanyDashboard({ history, users, cabs, revenueGoal, setRevenueGoal, userGoals }) {
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

  // Предыдущий аналогичный период для сравнения
  const prevFiltered = useMemo(() => {
    let h = history;
    if (filterUser !== 'all') h = h.filter(r => r.user_login === filterUser);
    if (filterCab  !== 'all') h = h.filter(r => r.cabinet    === filterCab);
    const now = new Date();
    if (period === 'month') {
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const from = `${y}-${String(m+1).padStart(2,'0')}-01`;
      const to   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
      return h.filter(r => { const d = (r.date||'').split('T')[0]; return d >= from && d <= to; });
    }
    if (period === 'week') {
      const ms = 7 * 24 * 60 * 60 * 1000;
      const from = new Date(Date.now() - 2*ms).toISOString().split('T')[0];
      const to   = new Date(Date.now() - ms).toISOString().split('T')[0];
      return h.filter(r => { const d = (r.date||'').split('T')[0]; return d >= from && d <= to; });
    }
    return [];
  }, [history, period, filterUser, filterCab]);

  const calcTotal = (arr) => {
    if (!arr.length) return null;
    const sum = f => arr.reduce((a, r) => a + (parseFloat(r[f]) || 0), 0);
    const rev = sum('rev'), profit = sum('profit'), ads = sum('ads'),
          cost = sum('cost'), comm = sum('comm'), log_f = sum('log_f'), log_r = sum('log_r'), ret = sum('ret');
    return { rev, profit, ads, cost, comm, log_f, log_r, ret,
      margin: rev > 0 ? profit / rev * 100 : 0,
      drr:    rev > 0 ? ads / rev * 100 : 0,
      days:   arr.length };
  };

  const total     = useMemo(() => calcTotal(filtered),     [filtered]);
  const prevTotal = useMemo(() => calcTotal(prevFiltered), [prevFiltered]);

  const diff = (cur, prev) => {
    if (!prev || prev === 0) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  };

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

  // Данные для линейного графика по дням
  const dailyData = useMemo(() => {
    const map = {};
    filtered.forEach(r => {
      const d = (r.date || '').split('T')[0];
      if (!d) return;
      if (!map[d]) map[d] = { rev: 0, profit: 0 };
      map[d].rev    += parseFloat(r.rev)    || 0;
      map[d].profit += parseFloat(r.profit) || 0;
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));
  }, [filtered]);

  const userLogins = [...new Set(history.map(r => r.user_login).filter(Boolean))];
  const totalExp = total ? total.cost + total.ads + total.comm + total.log_f + total.log_r + total.ret : 0;

  return (
    <div className="fade-in">
      {/* Трекер планов сотрудников */}
      {(() => {
        const curMonth = new Date().toISOString().slice(0, 7);
        const withGoals = (userGoals || []).filter(g => g.month === curMonth && +g.goal > 0);
        if (!withGoals.length) return null;
        return (
          <div className="card" style={{ padding: '16px 20px', marginBottom: 16 }}>
            <div className="section-title" style={{ marginBottom: 14 }}>🎯 Планы на {curMonth}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {withGoals.map(g => {
                const u = users.find(x => x.id === g.user_id);
                if (!u) return null;
                const status = calcPlanStatus(+g.goal, history, u.login, curMonth);
                if (!status) return null;
                const { actual, goal: gv, expectedByToday, delta, deltaPct, progressPct, daysPassed, daysLeft, forecast } = status;
                const ahead = delta >= 0;
                return (
                  <div key={g.user_id}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>{initials(u.name || u.login)}</div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name || u.login}</div>
                          <div style={{ fontSize: 10, color: 'var(--txt3)' }}>
                            День {daysPassed} · осталось {daysLeft} дн. · план {fmt(gv)} ₸
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: ahead ? 'var(--green-txt)' : 'var(--red-txt)' }}>
                          {ahead ? '▲ Опережает' : '▼ Отстаёт'} {Math.abs(deltaPct).toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                          {ahead ? '+' : '−'}{fmt(Math.abs(delta))} ₸ от темпа
                        </div>
                      </div>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-fill" style={{
                        width: progressPct + '%',
                        background: progressPct >= 100 ? 'var(--green-txt)' : ahead ? 'var(--blue)' : 'var(--yellow-txt)',
                        transition: 'width 0.6s ease',
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--txt3)', marginTop: 4 }}>
                      <span>{fmt(actual)} ₸ ({progressPct.toFixed(1)}%)</span>
                      <span>Нужно было: {fmt(expectedByToday)} ₸</span>
                      <span style={{ color: forecast >= gv ? 'var(--green-txt)' : 'var(--yellow-txt)', fontWeight: 600 }}>
                        Прогноз: {fmt(forecast)} ₸
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

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

      {/* Цель по выручке */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>🎯 Цель выручки:</span>
        <input type="number" className="form-input" value={revenueGoal || ''} placeholder="Введи план ₸"
          style={{ width: 160 }} onChange={e => setRevenueGoal(+e.target.value || 0)} />
        {revenueGoal > 0 && total && (
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>{fmt(total.rev)} ₸ из {fmt(revenueGoal)} ₸</span>
              <span style={{ fontWeight: 700, color: total.rev >= revenueGoal ? 'var(--green-txt)' : 'var(--yellow-txt)' }}>
                {fmtP(Math.min(total.rev / revenueGoal * 100, 100))}%
                {total.rev >= revenueGoal ? ' ✓' : ''}
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{
                width: Math.min(total.rev / revenueGoal * 100, 100) + '%',
                background: total.rev >= revenueGoal ? 'var(--green-txt)' : 'var(--blue)',
              }} />
            </div>
          </div>
        )}
      </div>

      {!total ? (
        <div className="card"><EmptyState type="chart" /></div>
      ) : (<>
        {/* KPI + сравнение периодов */}
        <div className="kpi-grid">
          {[
            { l: 'Общая выручка',  f: 'rev',    fmt: 'money', type: 'rev',    val: total.rev },
            { l: 'Чистая прибыль', f: 'profit', fmt: 'money', type: 'profit', val: total.profit },
            { l: 'Маржа',          f: 'margin', fmt: 'pct',   type: 'margin', val: total.margin },
            { l: 'ДРР',            f: 'drr',    fmt: 'pct',   type: 'drr',    val: total.drr },
          ].map(k => {
            const d = prevTotal ? diff(total[k.f], prevTotal[k.f]) : null;
            return (
              <div key={k.l} className="kpi-card">
                <div className="kpi-label">{k.l}</div>
                <div className="kpi-value">
                  <AnimatedKpi value={k.val} format={k.fmt} color={kpiColor(k.type, k.val)} />
                </div>
                {d !== null ? (
                  <div className="kpi-sub" style={{ color: d >= 0 ? 'var(--green-txt)' : 'var(--red-txt)', fontWeight: 600 }}>
                    {d >= 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)}% vs прошлый
                  </div>
                ) : (
                  <div className="kpi-sub">{total.days} записей</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Линейный график по дням */}
        {dailyData.length > 1 && (() => {
          const W = 620, H = 180, pad = { t: 16, r: 16, b: 32, l: 68 };
          const allVals = [...dailyData.map(d => d.rev), ...dailyData.map(d => d.profit)];
          const maxV = Math.max(...allVals);
          const minV = Math.min(...allVals, 0);
          const range = maxV - minV || 1;
          const iW = W - pad.l - pad.r;
          const iH = H - pad.t - pad.b;
          const x = i => pad.l + (i / (dailyData.length - 1)) * iW;
          const y = v => pad.t + iH - ((v - minV) / range) * iH;
          const ptsRev    = dailyData.map((d, i) => `${x(i)},${y(d.rev)}`).join(' ');
          const ptsProfit = dailyData.map((d, i) => `${x(i)},${y(d.profit)}`).join(' ');
          const fillRev = `${pad.l},${pad.t + iH} ${ptsRev} ${pad.l + iW},${pad.t + iH}`;
          const tickCount = Math.min(dailyData.length, 6);
          const tickIdxs  = Array.from({ length: tickCount }, (_, i) => Math.round(i * (dailyData.length - 1) / (tickCount - 1)));
          const zero0 = minV < 0 ? y(0) : null;
          return (
            <div className="card" style={{ padding: '16px 20px', marginBottom: 12, overflowX: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="section-title" style={{ marginBottom: 0 }}>📈 Динамика по дням</div>
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--txt3)' }}>
                  <span><span style={{ display: 'inline-block', width: 16, height: 3, background: 'var(--blue)', borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }} />Выручка</span>
                  <span><span style={{ display: 'inline-block', width: 16, height: 3, background: 'var(--green-txt)', borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }} />Прибыль</span>
                </div>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, height: H }}>
                {/* Сетка */}
                {[0, 0.25, 0.5, 0.75, 1].map(f => {
                  const yy = pad.t + iH * f;
                  const val = maxV - f * range;
                  return (
                    <g key={f}>
                      <line x1={pad.l} y1={yy} x2={pad.l + iW} y2={yy}
                        stroke="var(--border)" strokeWidth="0.5" strokeDasharray="4 4" />
                      <text x={pad.l - 6} y={yy + 4} textAnchor="end" style={{ fontSize: 9, fill: 'var(--txt3)' }}>
                        {val >= 1e6 ? (val/1e6).toFixed(1)+'M' : val >= 1e3 ? (val/1e3).toFixed(0)+'K' : val.toFixed(0)}
                      </text>
                    </g>
                  );
                })}
                {/* Нулевая линия если есть отрицательные значения */}
                {zero0 !== null && (
                  <line x1={pad.l} y1={zero0} x2={pad.l + iW} y2={zero0}
                    stroke="var(--border)" strokeWidth="1" />
                )}
                {/* Заливка выручки */}
                <polygon points={fillRev} fill="var(--blue)" opacity="0.08" />
                {/* Линия выручки */}
                <polyline points={ptsRev} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinejoin="round" />
                {/* Линия прибыли */}
                <polyline points={ptsProfit} fill="none" stroke="var(--green-txt)" strokeWidth="2" strokeLinejoin="round" strokeDasharray="0" />
                {/* Точки */}
                {dailyData.map((d, i) => (
                  <g key={i}>
                    <circle cx={x(i)} cy={y(d.rev)} r="3" fill="var(--blue)" />
                    <circle cx={x(i)} cy={y(d.profit)} r="2.5" fill="var(--green-txt)" />
                  </g>
                ))}
                {/* Метки дат */}
                {tickIdxs.map(i => (
                  <text key={i} x={x(i)} y={H - 4} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--txt3)' }}>
                    {dailyData[i].date.slice(5)}
                  </text>
                ))}
              </svg>
            </div>
          );
        })()}

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
function HistoryPanel({ history, setHist, users, cabs, isAdmin, userLogin, onDelete, onClear }) {
  const [period,      setPeriod]     = useState('month');
  const [dateFrom,    setDateFrom]   = useState('');
  const [dateTo,      setDateTo]     = useState('');
  const [filterCab,   setFilterCab]  = useState('all');
  const [filterUser,  setFilterUser] = useState('all');
  const [delConfirm,  setDelConfirm] = useState(null);
  const [editRec,     setEditRec]    = useState(null);

  const exportCSV = (rows) => {
    const cols = ['Дата','Кабинет','Сотрудник','Выручка','Реклама','Себест.','Комиссия','Лог.дост.','Лог.возвр.','Возвраты','Прибыль','Маржа%','ДРР%','Комментарий'];
    const lines = [cols.join(';'), ...rows.map(r => [
      r.date?.split('T')[0], r.cabinet, r.user_login,
      r.rev, r.ads, r.cost, r.comm, r.log_f, r.log_r, r.ret, r.profit,
      fmtP(parseFloat(r.margin)), fmtP(parseFloat(r.drr)), r.comment||'',
    ].join(';'))];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `wb_history_${toDay()}.csv`; a.click();
  };

  const exportXLSX = (rows) => {
    const data = [
      ['Дата','Кабинет','Сотрудник','Выручка','Реклама','Себест.','Комиссия','Лог.дост.','Лог.возвр.','Возвраты','Прибыль','Маржа%','ДРР%','Комментарий'],
      ...rows.map(r => [
        r.date?.split('T')[0], r.cabinet, r.user_login,
        +r.rev||0, +r.ads||0, +r.cost||0, +r.comm||0, +r.log_f||0, +r.log_r||0, +r.ret||0, +r.profit||0,
        parseFloat(r.margin)||0, parseFloat(r.drr)||0, r.comment||'',
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [10,16,14,12,12,12,12,12,12,12,12,10,10,20].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'История');
    XLSX.writeFile(wb, `wb_history_${toDay()}.xlsx`);
  };

  const visible = isAdmin ? history : history.filter(h => h.user_login === userLogin);

  const filtered = useMemo(() => {
    let h = visible;
    if (filterCab  !== 'all') h = h.filter(r => r.cabinet    === filterCab);
    if (filterUser !== 'all') h = h.filter(r => r.user_login === filterUser);
    return filterByRange(h, 'date', { period, dateFrom, dateTo });
  }, [visible, period, dateFrom, dateTo, filterCab, filterUser]);

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

      {/* Модалка редактирования */}
      {editRec && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditRec(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2>Редактировать запись</h2>
              <button className="modal-close" onClick={() => setEditRec(null)}>×</button>
            </div>
            {[
              { l: 'Дата', k: 'date', type: 'date' },
              { l: 'Выручка ₸', k: 'rev', type: 'number' },
              { l: 'Реклама ₸', k: 'ads', type: 'number' },
              { l: 'Себестоимость ₸', k: 'cost', type: 'number' },
              { l: 'Комиссия ₸', k: 'comm', type: 'number' },
              { l: 'Логистика доставки ₸', k: 'log_f', type: 'number' },
              { l: 'Логистика возвратов ₸', k: 'log_r', type: 'number' },
              { l: 'Потери на возвраты ₸', k: 'ret', type: 'number' },
              { l: 'Заметка', k: 'comment', type: 'text' },
            ].map(f => (
              <div key={f.k} style={{ marginBottom: 10 }}>
                <label className="form-label">{f.l}</label>
                <input type={f.type} className="form-input" value={editRec[f.k] ?? ''}
                  onChange={e => setEditRec(r => ({ ...r, [f.k]: e.target.value }))} />
              </div>
            ))}
            <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)' }}>
              {(() => {
                const rev = +editRec.rev || 0, ads = +editRec.ads || 0, cost = +editRec.cost || 0;
                const comm = +editRec.comm || 0, logF = +editRec.log_f || 0, logR = +editRec.log_r || 0, ret = +editRec.ret || 0;
                const profit = rev - ads - cost - comm - logF - logR - ret;
                const margin = rev > 0 ? profit / rev * 100 : 0;
                return <span style={{ fontSize: 12, color: 'var(--txt2)' }}>
                  Прибыль: <b style={{ color: kpiColor('profit', profit) }}>{fmt(profit)} ₸</b>
                  {' · '}Маржа: <b style={{ color: kpiColor('margin', margin) }}>{fmtP(margin)}%</b>
                </span>;
              })()}
            </div>
            <button className="btn btn-primary btn-full" onClick={async () => {
              const rev = +editRec.rev || 0, ads = +editRec.ads || 0, cost = +editRec.cost || 0;
              const comm = +editRec.comm || 0, logF = +editRec.log_f || 0, logR = +editRec.log_r || 0, ret = +editRec.ret || 0;
              const profit = rev - ads - cost - comm - logF - logR - ret;
              const margin = rev > 0 ? profit / rev * 100 : 0;
              const drr    = rev > 0 ? ads    / rev * 100 : 0;
              const updated = await api.updateHistory(editRec.id, { ...editRec, rev, ads, cost, comm, log_f: logF, log_r: logR, ret, profit, margin, drr });
              setHist(h => h.map(r => r.id === updated.id ? updated : r));
              setEditRec(null);
            }}>Сохранить</button>
          </div>
        </div>
      )}

      {/* Фильтр по сотруднику (только для админа) */}
      {isAdmin && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {[{ v: 'all', l: 'Все сотрудники' }, ...users.map(u => ({ v: u.login, l: u.name || u.login }))].map(o => (
            <button key={o.v} className={`pill ${filterUser === o.v ? 'active' : ''}`}
              onClick={() => setFilterUser(o.v)}>{o.l}</button>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => exportCSV(filtered)}>📥 CSV</button>
          <button className="btn" onClick={() => exportXLSX(filtered)}>📊 Excel</button>
          {isAdmin && <button className="btn btn-danger" onClick={() => setDelConfirm('all')}>Очистить всю историю</button>}
        </div>
      )}

      {summary && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          {[
            { l: 'Выручка', v: summary.rev,    fmt: 'money', col: 'var(--blue-txt)',               type: 'rev' },
            { l: 'Расходы', v: summary.cost + summary.ads + summary.comm + summary.log_f + summary.log_r + summary.ret, fmt: 'money', col: 'var(--red-txt)', type: 'rev' },
            { l: 'Прибыль', v: summary.profit, fmt: 'money', col: kpiColor('profit',summary.profit), type: 'profit' },
            { l: 'Маржа',   v: summary.margin, fmt: 'pct',   col: kpiColor('margin',summary.margin), type: 'margin' },
          ].map(k => (
            <div key={k.l} className="kpi-card">
              <div className="kpi-label">{k.l}</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>
                <AnimatedKpi value={k.v} format={k.fmt} color={k.col} />
              </div>
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
          <EmptyState type="history" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Дата</th>
                <th style={{ textAlign: 'left' }}>Кабинет</th>
                {isAdmin && <th style={{ textAlign: 'left' }}>Сотрудник</th>}
                <th>Выручка</th><th>Себес.</th><th>Реклама</th><th>Комиссия</th>
                <th>Логистика</th><th>Возвраты</th><th>Прибыль</th><th>Маржа</th><th>ДРР</th>
                <th style={{ textAlign: 'left' }}>Заметка</th>
                <th></th>
              </tr></thead>
              <tbody>
                {filtered.map(h => (
                  <tr key={h.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, color: 'var(--txt)' }}>{h.date?.split('T')[0] || h.date}</div>
                      {h.created_at && (
                        <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 2 }}>
                          {new Date(h.created_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      )}
                    </td>
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
                    <td style={{ maxWidth: 120, fontSize: 11, color: 'var(--txt3)' }}>
                      {h.comment ? (
                        <span title={h.comment} style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          💬 {h.comment}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button onClick={() => setEditRec({ ...h })} style={{ background: 'none', border: 'none',
                          cursor: 'pointer', color: 'var(--txt3)', fontSize: 14, padding: '0 4px' }}
                          onMouseEnter={e => e.target.style.color = 'var(--blue-txt)'}
                          onMouseLeave={e => e.target.style.color = 'var(--txt3)'}>✏️</button>
                        {isAdmin && (
                          <button onClick={() => setDelConfirm(h.id)} style={{ background: 'none', border: 'none',
                            cursor: 'pointer', color: 'var(--txt3)', fontSize: 16, padding: '0 4px' }}
                            onMouseEnter={e => e.target.style.color = 'var(--red-txt)'}
                            onMouseLeave={e => e.target.style.color = 'var(--txt3)'}>×</button>
                        )}
                      </div>
                    </td>
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

// ── Отчёт по выкупам + ЗП ────────────────────────────────────────────────────
function ReportPanel({ history, users, allCabs, isAdmin, userLogin }) {
  const [period,   setPeriod]   = useState('month');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');

  const visible = isAdmin ? history : history.filter(h => h.user_login === userLogin);

  const filtered = useMemo(() =>
    filterByRange(visible, 'date', { period, dateFrom, dateTo }),
    [visible, period, dateFrom, dateTo]);

  // Выкупы = выручка − комиссия − логистика − возвраты − реклама
  const rowBuyouts = r => {
    const rev  = parseFloat(r.rev)   || 0;
    const comm = parseFloat(r.comm)  || 0;
    const logF = parseFloat(r.log_f) || 0;
    const logR = parseFloat(r.log_r) || 0;
    const ret  = parseFloat(r.ret)   || 0;
    const ads  = parseFloat(r.ads)   || 0;
    return rev - comm - logF - logR - ret - ads;
  };

  // Данные по кабинетам
  const byCab = useMemo(() => {
    const map = {};
    filtered.forEach(r => {
      const k = r.cabinet || '—';
      if (!map[k]) map[k] = { rev: 0, buyoutsSum: 0, profit: 0, ads: 0, cost: 0, comm: 0, logF: 0, logR: 0, ret: 0, cnt: 0, days: new Set() };
      map[k].rev       += parseFloat(r.rev)    || 0;
      map[k].buyoutsSum+= rowBuyouts(r);
      map[k].profit    += parseFloat(r.profit) || 0;
      map[k].ads       += parseFloat(r.ads)    || 0;
      map[k].cost      += parseFloat(r.cost)   || 0;
      map[k].comm      += parseFloat(r.comm)   || 0;
      map[k].logF      += parseFloat(r.log_f)  || 0;
      map[k].logR      += parseFloat(r.log_r)  || 0;
      map[k].ret       += parseFloat(r.ret)    || 0;
      map[k].cnt++;
      if (r.date) map[k].days.add(r.date);
    });
    return Object.entries(map).map(([name, m]) => {
      const cab = allCabs.find(c => c.name === name);
      const days = m.days.size || 1;
      return {
        name, ...m,
        buyoutPct: cab?.buyout ?? '—',
        margin:    m.rev > 0 ? m.profit     / m.rev * 100 : 0,
        marginB:   m.buyoutsSum > 0 ? m.profit / m.buyoutsSum * 100 : 0,
        drr:       m.rev > 0 ? m.ads        / m.rev * 100 : 0,
        dailyRev:  m.rev / days,
        dailyB:    m.buyoutsSum / days,
      };
    }).sort((a, b) => b.buyoutsSum - a.buyoutsSum);
  }, [filtered, allCabs]);

  // Суммарные итоги
  const totals = useMemo(() => {
    const t = { rev: 0, buyoutsSum: 0, profit: 0, ads: 0, cost: 0, comm: 0, logF: 0, logR: 0, ret: 0 };
    filtered.forEach(r => {
      t.rev       += parseFloat(r.rev)    || 0;
      t.buyoutsSum+= rowBuyouts(r);
      t.profit    += parseFloat(r.profit) || 0;
      t.ads       += parseFloat(r.ads)    || 0;
      t.cost      += parseFloat(r.cost)   || 0;
      t.comm      += parseFloat(r.comm)   || 0;
      t.logF      += parseFloat(r.log_f)  || 0;
      t.logR      += parseFloat(r.log_r)  || 0;
      t.ret       += parseFloat(r.ret)    || 0;
    });
    t.drr    = t.rev > 0 ? t.ads    / t.rev * 100 : 0;
    t.margin = t.rev > 0 ? t.profit / t.rev * 100 : 0;
    return t;
  }, [filtered]);

  // ЗП
  const salaryRows = useMemo(() => {
    const calc = recs => recs.reduce((s, r) => s + rowBuyouts(r), 0);
    if (!isAdmin) {
      const u = users.find(u => u.login === userLogin);
      if (!u) return [];
      const myRecs = filtered.filter(r => r.user_login === userLogin);
      const buyouts = calc(myRecs);
      const rev = myRecs.reduce((s, r) => s + (parseFloat(r.rev) || 0), 0);
      const pct = parseFloat(u.salary_pct) || 0;
      return [{ ...u, buyouts, rev, salary: buyouts * pct / 100, pct }];
    }
    return users.map(u => {
      const recs = filtered.filter(r => r.user_login === u.login);
      const buyouts = calc(recs);
      const rev = recs.reduce((s, r) => s + (parseFloat(r.rev) || 0), 0);
      const pct = parseFloat(u.salary_pct) || 0;
      return { ...u, buyouts, rev, salary: buyouts * pct / 100, pct };
    }).filter(u => u.rev > 0).sort((a, b) => b.buyouts - a.buyouts);
  }, [filtered, users, isAdmin, userLogin]);

  // Бар-чарт SVG
  const maxB = Math.max(...byCab.map(c => Math.abs(c.buyoutsSum)), 1);
  const BAR_H = 160, BAR_W = Math.max(48, Math.min(80, Math.floor(700 / (byCab.length || 1)) - 16));

  return (
    <div className="fade-in">
      <FilterBar period={period} setPeriod={setPeriod}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo} />

      {filtered.length === 0 ? (
        <div className="card"><EmptyState type="report" /></div>
      ) : (
        <>
          {/* ── Таблица по кабинетам ── */}
          <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Отчёт по выкупам</div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr>
                  <th style={{ textAlign: 'left' }}>Кабинет</th>
                  <th style={{ textAlign: 'right' }}>Выкупы за период</th>
                  <th style={{ textAlign: 'right' }}>Маржа %</th>
                  <th style={{ textAlign: 'right' }}>В среднем за день</th>
                  <th style={{ textAlign: 'right' }}>ДРР %</th>
                  <th style={{ textAlign: 'right' }}>Выкуп %</th>
                </tr></thead>
                <tbody>
                  {byCab.map((c, i) => (
                    <tr key={c.name}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--txt3)', minWidth: 16 }}>{i + 1}</span>
                          <span style={{ fontWeight: 600 }}>{c.name}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 15,
                        color: c.buyoutsSum >= 0 ? 'var(--green-txt)' : 'var(--red-txt)' }}>
                        {fmt(c.buyoutsSum)} ₸
                      </td>
                      <td style={{ textAlign: 'right', color: kpiColor('margin', c.margin) }}>
                        {c.margin >= 0 ? '+' : ''}{fmtP(c.margin)}%
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--blue-txt)' }}>
                        {fmt(c.dailyB)} ₸
                      </td>
                      <td style={{ textAlign: 'right', color: kpiColor('drr', c.drr) }}>
                        {fmtP(c.drr)}%
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="badge" style={{
                          background: +c.buyoutPct >= 85 ? 'var(--green-bg)' : +c.buyoutPct >= 70 ? 'var(--yellow-bg)' : 'var(--red-bg)',
                          color:      +c.buyoutPct >= 85 ? 'var(--green-txt)' : +c.buyoutPct >= 70 ? 'var(--yellow-txt)' : 'var(--red-txt)',
                        }}>{c.buyoutPct}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Бар-чарт ── */}
          {byCab.length > 0 && (
            <div className="card" style={{ padding: '20px 24px', marginBottom: 16, overflowX: 'auto' }}>
              <div className="section-title" style={{ marginBottom: 20 }}>График выкупов по кабинетам</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, minWidth: byCab.length * (BAR_W + 12), paddingBottom: 48, position: 'relative' }}>
                {/* нулевая линия */}
                <div style={{ position: 'absolute', bottom: 48, left: 0, right: 0,
                  borderTop: '1px dashed rgba(255,255,255,0.1)' }} />
                {byCab.map(c => {
                  const pct = Math.abs(c.buyoutsSum) / maxB;
                  const h = Math.max(4, pct * BAR_H);
                  const isNeg = c.buyoutsSum < 0;
                  const mPct = c.margin;
                  return (
                    <div key={c.name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: BAR_W }}>
                      <div style={{ fontSize: 11, fontWeight: 700,
                        color: isNeg ? 'var(--red-txt)' : mPct >= 20 ? 'var(--green-txt)' : mPct >= 10 ? 'var(--yellow-txt)' : 'var(--txt2)' }}>
                        {mPct >= 0 ? '+' : ''}{fmtP(mPct)}%
                      </div>
                      <div style={{
                        width: '100%', height: h,
                        background: isNeg
                          ? 'linear-gradient(180deg, var(--red-bg) 0%, rgba(239,68,68,0.6) 100%)'
                          : 'linear-gradient(180deg, rgba(79,124,255,0.9) 0%, rgba(79,124,255,0.5) 100%)',
                        borderRadius: '6px 6px 0 0',
                        border: `1px solid ${isNeg ? 'rgba(239,68,68,0.4)' : 'rgba(79,124,255,0.4)'}`,
                        position: 'relative',
                      }} />
                      <div style={{ fontSize: 10, color: 'var(--txt3)', textAlign: 'center',
                        position: 'absolute', bottom: 0, width: BAR_W,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Сводка итогов ── */}
          <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Сводка за период</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
              {[
                { l: 'Выручка',       v: fmt(totals.rev)       + ' ₸', col: 'var(--blue-txt)',   bg: 'var(--blue-bg)' },
                { l: 'Выкупы',        v: fmt(totals.buyoutsSum)+ ' ₸', col: 'var(--green-txt)',  bg: 'var(--green-bg)' },
                { l: 'Реклама',       v: fmt(totals.ads)       + ' ₸', col: 'var(--yellow-txt)', bg: 'var(--yellow-bg)' },
                { l: 'ДРР %',         v: fmtP(totals.drr)      + '%',  col: 'var(--yellow-txt)', bg: 'var(--yellow-bg)' },
                { l: 'Себестоимость', v: fmt(totals.cost)      + ' ₸', col: 'var(--red-txt)',    bg: 'var(--red-bg)' },
                { l: 'Комиссия ВБ',   v: fmt(totals.comm)      + ' ₸', col: 'var(--red-txt)',    bg: 'var(--red-bg)' },
                { l: 'Логистика',     v: fmt(totals.logF + totals.logR) + ' ₸', col: 'var(--red-txt)', bg: 'var(--red-bg)' },
                { l: 'Возвраты',      v: fmt(totals.ret)       + ' ₸', col: 'var(--red-txt)',    bg: 'var(--red-bg)' },
                { l: 'Прибыль',       v: fmt(totals.profit)    + ' ₸', col: kpiColor('profit', totals.profit), bg: totals.profit >= 0 ? 'var(--green-bg)' : 'var(--red-bg)' },
                { l: 'Маржа %',       v: fmtP(totals.margin)   + '%',  col: kpiColor('margin', totals.margin), bg: totals.margin >= 15 ? 'var(--green-bg)' : totals.margin >= 5 ? 'var(--yellow-bg)' : 'var(--red-bg)' },
              ].map(k => (
                <div key={k.l} style={{ background: k.bg, borderRadius: 10, padding: '14px 16px',
                  border: `1px solid ${k.col}22` }}>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 6 }}>{k.l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: k.col }}>{k.v}</div>
                </div>
              ))}
            </div>
          </div>

        </>
      )}
    </div>
  );
}

// ── Команды ───────────────────────────────────────────────────────────────────
function TeamsPanel({ teams, setTeams, users, history }) {
  const [period,      setPeriod]      = useState('month');
  const [dateFrom,    setDateFrom]    = useState('');
  const [dateTo,      setDateTo]      = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [editTeam,    setEditTeam]    = useState(null); // команда для редактирования участников
  const [err,         setErr]         = useState('');

  const addTeam = async () => {
    if (!newTeamName.trim()) return;
    try {
      const t = await api.addTeam(newTeamName.trim());
      setTeams(x => [...x, t]);
      setNewTeamName('');
    } catch (e) { setErr(e.message); }
  };

  const delTeam = async id => {
    await api.deleteTeam(id);
    setTeams(x => x.filter(t => t.id !== id));
  };

  const toggleMember = async (teamId, userId) => {
    const team = teams.find(t => t.id === teamId);
    const current = team?.member_ids || [];
    const next = current.includes(userId) ? current.filter(x => x !== userId) : [...current, userId];
    await api.setTeamMembers(teamId, next);
    setTeams(ts => ts.map(t => t.id === teamId ? { ...t, member_ids: next } : t));
  };

  const filtered = useMemo(() =>
    filterByRange(history, 'date', { period, dateFrom, dateTo }),
    [history, period, dateFrom, dateTo]);

  // Статистика по командам
  const teamStats = useMemo(() => {
    return teams.map(team => {
      const memberUsers = (team.member_ids || []).map(id => users.find(u => u.id === id)).filter(Boolean);
      const logins = memberUsers.map(u => u.login);
      const recs = filtered.filter(r => logins.includes(r.user_login));
      const rev    = recs.reduce((s, r) => s + (parseFloat(r.rev)    || 0), 0);
      const profit = recs.reduce((s, r) => s + (parseFloat(r.profit) || 0), 0);
      const ads    = recs.reduce((s, r) => s + (parseFloat(r.ads)    || 0), 0);
      // Рейтинг участников
      const memberStats = memberUsers.map(u => {
        const ur = recs.filter(r => r.user_login === u.login);
        const uRev = ur.reduce((s, r) => s + (parseFloat(r.rev) || 0), 0);
        const uProfit = ur.reduce((s, r) => s + (parseFloat(r.profit) || 0), 0);
        return { ...u, rev: uRev, profit: uProfit };
      }).sort((a, b) => b.rev - a.rev);
      return { ...team, rev, profit, ads,
        margin: rev > 0 ? profit / rev * 100 : 0,
        drr:    rev > 0 ? ads    / rev * 100 : 0,
        cnt: recs.length, logins, memberStats };
    }).sort((a, b) => b.rev - a.rev);
  }, [teams, filtered, users]);

  const medals = ['🥇', '🥈', '🥉'];
  const employees = users;

  // Уникальные логины из истории за период
  const historyLogins = [...new Set(filtered.map(r => r.user_login).filter(Boolean))];

  return (
    <div className="fade-in">
      {/* Диагностика — показывает что не совпадает */}
      {teamStats.every(t => t.rev === 0) && filtered.length > 0 && (
        <div style={{ marginBottom: 12, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 12 }}>
          <div style={{ color: 'var(--yellow-txt)', fontWeight: 600, marginBottom: 8 }}>
            ⚠️ В истории есть данные ({filtered.length} записей), но они не привязаны к участникам команд
          </div>
          <div style={{ color: 'var(--txt2)', marginBottom: 4 }}>
            Логины в истории: <b style={{ color: 'var(--txt)' }}>{historyLogins.join(', ') || '—'}</b>
          </div>
          <div style={{ color: 'var(--txt2)' }}>
            Логины участников команд: <b style={{ color: 'var(--txt)' }}>
              {[...new Set(teamStats.flatMap(t => t.logins))].join(', ') || '—'}
            </b>
          </div>
        </div>
      )}
      <FilterBar period={period} setPeriod={setPeriod}
        dateFrom={dateFrom} setDateFrom={setDateFrom}
        dateTo={dateTo} setDateTo={setDateTo} />

      {/* Модалка участников */}
      {editTeam && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditTeam(null)}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Участники — {editTeam.name}</h2>
              <button className="modal-close" onClick={() => setEditTeam(null)}>×</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 14 }}>
              Выберите сотрудников команды:
            </div>
            {employees.length === 0 ? (
              <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Нет сотрудников</div>
            ) : employees.map(u => {
              const checked = (editTeam.member_ids || []).includes(u.id);
              return (
                <label key={u.id} onClick={async () => {
                  await toggleMember(editTeam.id, u.id);
                  setEditTeam(t => ({
                    ...t, member_ids: checked
                      ? t.member_ids.filter(x => x !== u.id)
                      : [...t.member_ids, u.id]
                  }));
                }} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                  background: checked ? 'var(--blue-bg)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${checked ? 'rgba(79,124,255,0.35)' : 'var(--border)'}`,
                }}>
                  <div style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                    border: `2px solid ${checked ? 'var(--blue)' : 'var(--border)'}`,
                    background: checked ? 'var(--blue)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, color: '#fff', fontWeight: 700 }}>{checked ? '✓' : ''}</div>
                  <div className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>{initials(u.name || u.login)}</div>
                  <span style={{ fontSize: 13, fontWeight: checked ? 600 : 400 }}>{u.name || u.login}</span>
                </label>
              );
            })}
            <button className="btn btn-primary btn-full" style={{ marginTop: 16 }}
              onClick={() => setEditTeam(null)}>Готово</button>
          </div>
        </div>
      )}

      {err && <div className="err-msg" style={{ marginBottom: 12 }}>{err}</div>}

      {/* Создать команду */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="form-input" value={newTeamName} onChange={e => setNewTeamName(e.target.value)}
          placeholder="Название новой команды" onKeyDown={e => e.key === 'Enter' && addTeam()}
          style={{ flex: 1 }} />
        <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={addTeam}>+ Создать команду</button>
      </div>

      {teams.length === 0 ? (
        <div className="card"><EmptyState type="teams" /></div>
      ) : (
        <>
          {/* Лидерборд карточки */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
            {teamStats.map((team, i) => (
              <div key={team.id} className="card" style={{
                padding: '20px 24px',
                border: i === 0 && team.rev > 0 ? '1px solid rgba(245,158,11,0.3)' : undefined,
                background: i === 0 && team.rev > 0 ? 'rgba(245,158,11,0.04)' : undefined,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>
                      {team.rev > 0 && medals[i] ? medals[i] + ' ' : ''}{team.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>
                      {team.logins.length} участников · {team.cnt} записей
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }}
                      onClick={() => setEditTeam(teams.find(t => t.id === team.id))}>
                      👥 Участники
                    </button>
                    <button className="btn btn-danger" style={{ padding: '3px 10px', fontSize: 11 }}
                      onClick={() => delTeam(team.id)}>×</button>
                  </div>
                </div>

                <div style={{ fontSize: 24, fontWeight: 800, color: kpiColor('profit', team.profit),
                  letterSpacing: '-0.02em', marginBottom: 8 }}>
                  {fmt(team.profit)} ₸
                </div>
                <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 12 }}>
                  Выручка: <span style={{ color: 'var(--blue-txt)', fontWeight: 600 }}>{fmt(team.rev)} ₸</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { l: 'Маржа', v: fmtP(team.margin) + '%', col: kpiColor('margin', team.margin) },
                    { l: 'ДРР',   v: fmtP(team.drr) + '%',    col: kpiColor('drr', team.drr) },
                  ].map(k => (
                    <div key={k.l} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8,
                      padding: '8px 10px', textAlign: 'center', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: k.col }}>{k.v}</div>
                      <div style={{ fontSize: 10, color: 'var(--txt3)' }}>{k.l}</div>
                    </div>
                  ))}
                </div>

                {/* Рейтинг участников */}
                {team.memberStats?.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                    {team.memberStats.map((m, mi) => (
                      <div key={m.login} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: mi === 0 ? 'var(--yellow-txt)' : 'var(--txt3)', minWidth: 16 }}>
                          {medals[mi] || mi + 1}
                        </span>
                        <div className="avatar" style={{ width: 20, height: 20, fontSize: 8 }}>{initials(m.name || m.login)}</div>
                        <span style={{ fontSize: 12, flex: 1 }}>{m.name || m.login}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: kpiColor('profit', m.profit) }}>{fmt(m.rev)} ₸</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Сравнительная таблица */}
          {teamStats.some(t => t.rev > 0) && (
            <div className="card" style={{ padding: '20px 24px' }}>
              <div className="section-title" style={{ marginBottom: 16 }}>Сравнение команд</div>
              <table>
                <thead><tr>
                  <th style={{ textAlign: 'left' }}>#</th>
                  <th style={{ textAlign: 'left' }}>Команда</th>
                  <th>Участников</th>
                  <th>Выручка</th>
                  <th>Прибыль</th>
                  <th>Маржа</th>
                  <th>ДРР</th>
                </tr></thead>
                <tbody>
                  {teamStats.map((t, i) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 700, color: i === 0 ? 'var(--yellow-txt)' : 'var(--txt3)' }}>
                        {medals[i] || i + 1}
                      </td>
                      <td style={{ fontWeight: 600 }}>{t.name}</td>
                      <td style={{ textAlign: 'center', color: 'var(--txt2)' }}>{t.logins.length}</td>
                      <td style={{ textAlign: 'right', color: 'var(--blue-txt)', fontWeight: 600 }}>{fmt(t.rev)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: kpiColor('profit', t.profit) }}>{fmt(t.profit)}</td>
                      <td style={{ textAlign: 'right', color: kpiColor('margin', t.margin) }}>{fmtP(t.margin)}%</td>
                      <td style={{ textAlign: 'right', color: kpiColor('drr', t.drr) }}>{fmtP(t.drr)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Трекер плана ─────────────────────────────────────────────────────────────
// Считает план по календарным дням: ожидается goal / daysInMonth * daysPassed
function calcPlanStatus(goal, history, userLogin, month) {
  if (!goal || goal <= 0) return null;

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // сколько дней прошло (включая сегодня)
  const daysPassed = Math.min(today.getDate(), daysInMonth);

  // фактическая выручка за этот месяц у пользователя
  const actual = history
    .filter(r => r.user_login === userLogin && (r.date || '').startsWith(month))
    .reduce((s, r) => s + (parseFloat(r.rev) || 0), 0);

  const expectedByToday = (goal / daysInMonth) * daysPassed;
  const dailyPace       = goal / daysInMonth;
  const delta           = actual - expectedByToday;
  const deltaPct        = expectedByToday > 0 ? (delta / expectedByToday) * 100 : 0;
  const progressPct     = Math.min(actual / goal * 100, 100);

  // прогноз: если темп сохранится
  const avgPerDay = daysPassed > 0 ? actual / daysPassed : 0;
  const forecast  = avgPerDay * daysInMonth;

  return {
    goal, actual, expectedByToday, dailyPace, delta, deltaPct,
    progressPct, daysInMonth, daysPassed, daysLeft: daysInMonth - daysPassed,
    forecast, month,
  };
}

function PlanTracker({ status, compact = false }) {
  if (!status) return null;
  const { goal, actual, expectedByToday, delta, deltaPct, progressPct,
          daysPassed, daysLeft, forecast } = status;
  const ahead = delta >= 0;
  const statusColor = ahead ? 'var(--green-txt)' : 'var(--red-txt)';

  if (compact) {
    return (
      <div style={{ background: ahead ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
        border: `1px solid ${ahead ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)' }}>
            🎯 План на месяц: {fmt(goal)} ₸
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>
            {ahead ? '▲ Опережает' : '▼ Отстаёт'} {Math.abs(deltaPct).toFixed(1)}%
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--txt2)', marginBottom: 8 }}>
          <span>Факт: <b style={{ color: 'var(--blue-txt)' }}>{fmt(actual)} ₸</b></span>
          <span>Ожидалось: <b style={{ color: 'var(--txt)' }}>{fmt(expectedByToday)} ₸</b></span>
          <span>{ahead ? '+' : '−'}<b style={{ color: statusColor }}>{fmt(Math.abs(delta))} ₸</b></span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{
            width: progressPct + '%',
            background: progressPct >= 100 ? 'var(--green-txt)' : ahead ? 'var(--blue)' : 'var(--yellow-txt)',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--txt3)', marginTop: 4 }}>
          <span>День {daysPassed} из {status.daysInMonth}</span>
          <span>{progressPct.toFixed(1)}% плана выполнено</span>
          <span>Прогноз: {fmt(forecast)} ₸</span>
        </div>
      </div>
    );
  }

  // Полный вид для таблицы в AdminPanel
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>
        {ahead ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}%
      </div>
      <div style={{ fontSize: 10, color: 'var(--txt3)' }}>
        {fmt(actual)} / {fmt(goal)} ₸
      </div>
      <div style={{ width: 80, height: 4, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ width: Math.min(progressPct, 100) + '%', height: '100%',
          background: ahead ? 'var(--green-txt)' : 'var(--yellow-txt)', borderRadius: 2 }} />
      </div>
    </div>
  );
}

// ── Пустые состояния ─────────────────────────────────────────────────────────
const EMPTY_STATES = {
  chart: {
    icon: (
      <svg width="80" height="60" viewBox="0 0 80 60" fill="none">
        <rect x="8" y="38" width="12" height="14" rx="3" fill="var(--blue)" opacity="0.25"/>
        <rect x="26" y="28" width="12" height="24" rx="3" fill="var(--blue)" opacity="0.4"/>
        <rect x="44" y="18" width="12" height="34" rx="3" fill="var(--blue)" opacity="0.6"/>
        <rect x="62" y="8" width="12" height="44" rx="3" fill="var(--blue)" opacity="0.8"/>
        <line x1="4" y1="54" x2="76" y2="54" stroke="var(--border)" strokeWidth="2"/>
      </svg>
    ),
    title: 'Нет данных за период',
    sub: 'Заполни статистику в разделе Калькулятор',
  },
  history: {
    icon: (
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
        <rect x="12" y="16" width="48" height="44" rx="8" fill="var(--bg-card2)" stroke="var(--border)" strokeWidth="1.5"/>
        <rect x="20" y="28" width="32" height="3" rx="1.5" fill="var(--border)"/>
        <rect x="20" y="36" width="24" height="3" rx="1.5" fill="var(--border)"/>
        <rect x="20" y="44" width="16" height="3" rx="1.5" fill="var(--border)"/>
        <circle cx="54" cy="20" r="10" fill="var(--bg-card)" stroke="var(--border)" strokeWidth="1.5"/>
        <line x1="54" y1="15" x2="54" y2="21" stroke="var(--blue-txt)" strokeWidth="1.5" strokeLinecap="round"/>
        <line x1="54" y1="21" x2="57" y2="24" stroke="var(--blue-txt)" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
    title: 'История пуста',
    sub: 'Сохранённые записи появятся здесь',
  },
  teams: {
    icon: (
      <svg width="80" height="60" viewBox="0 0 80 60" fill="none">
        <circle cx="40" cy="22" r="12" fill="var(--blue-bg)" stroke="var(--blue)" strokeWidth="1.5"/>
        <circle cx="16" cy="34" r="9" fill="var(--purple-bg)" stroke="var(--purple)" strokeWidth="1.5"/>
        <circle cx="64" cy="34" r="9" fill="var(--green-bg)" stroke="var(--green)" strokeWidth="1.5"/>
        <path d="M28 50 Q40 42 52 50" stroke="var(--border)" strokeWidth="1.5" fill="none"/>
        <line x1="40" y1="34" x2="40" y2="42" stroke="var(--border)" strokeWidth="1.5"/>
      </svg>
    ),
    title: 'Команд пока нет',
    sub: 'Создай первую команду и добавь участников',
  },
  report: {
    icon: (
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
        <rect x="10" y="10" width="52" height="52" rx="10" fill="var(--bg-card2)" stroke="var(--border)" strokeWidth="1.5"/>
        <path d="M20 46 L30 32 L40 38 L52 22" stroke="var(--green-txt)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        <circle cx="20" cy="46" r="3" fill="var(--green-txt)"/>
        <circle cx="30" cy="32" r="3" fill="var(--green-txt)"/>
        <circle cx="40" cy="38" r="3" fill="var(--green-txt)"/>
        <circle cx="52" cy="22" r="3" fill="var(--green-txt)"/>
      </svg>
    ),
    title: 'Нет данных за период',
    sub: 'Выбери другой период или добавь записи',
  },
};

function EmptyState({ type = 'chart', action, actionLabel }) {
  const s = EMPTY_STATES[type] || EMPTY_STATES.chart;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px', gap: 12 }}>
      {s.icon}
      <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--txt)' }}>{s.title}</div>
      <div style={{ fontSize: 13, color: 'var(--txt3)', textAlign: 'center' }}>{s.sub}</div>
      {action && (
        <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={action}>{actionLabel}</button>
      )}
    </div>
  );
}

// ── Онбординг ─────────────────────────────────────────────────────────────────
const ONBOARDING_STEPS = [
  {
    tab: 'calc',
    title: '👋 Привет! Давай начнём',
    text: 'Это калькулятор прибыли для WB. Каждый день вводи выручку и расходы — сайт покажет сколько ты заработал чистыми.',
    anchor: 'top',
  },
  {
    tab: 'calc',
    title: '💰 Введи выручку и рекламу',
    text: 'Выручка — это сумма заказов из личного кабинета WB. Реклама вводится в рублях — курс подтянется автоматически.',
    anchor: 'form',
  },
  {
    tab: 'calc',
    title: '📦 Добавь товары',
    text: 'Выбери товар из списка и укажи количество штук. Себестоимость и комиссия подтянутся автоматически из каталога.',
    anchor: 'products',
  },
  {
    tab: 'calc',
    title: '💾 Сохрани запись',
    text: 'Нажми «Сохранить запись» — данные уйдут в историю. Черновик сохраняется автоматически, так что можно вернуться позже.',
    anchor: 'save',
  },
  {
    tab: 'history',
    title: '📋 История записей',
    text: 'Здесь хранятся все твои записи. Можно фильтровать по периоду, кабинету и скачать в Excel или CSV.',
    anchor: 'top',
  },
  {
    tab: 'company',
    title: '🏢 Компания',
    text: 'Раздел для руководителя — общая статистика, сравнение с прошлым периодом и график выручки по дням.',
    anchor: 'top',
  },
];

function OnboardingOverlay({ step, total, onNext, onSkip }) {
  const s = ONBOARDING_STEPS[step];
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 18, padding: '28px 32px',
        maxWidth: 380, width: '90%', boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--border)', animation: 'fadeIn 0.2s ease',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 600 }}>
            {step + 1} / {total}
          </span>
          <button onClick={onSkip} style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--txt3)', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        {/* Прогресс */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 2,
              background: i <= step ? 'var(--blue)' : 'var(--border)',
              transition: 'background 0.3s',
            }} />
          ))}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10, color: 'var(--txt)' }}>{s.title}</div>
        <div style={{ fontSize: 14, color: 'var(--txt2)', lineHeight: 1.6, marginBottom: 24 }}>{s.text}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onNext}>
            {step < total - 1 ? 'Дальше →' : '🎉 Начать работу'}
          </button>
          {step < total - 1 && (
            <button className="btn" onClick={onSkip} style={{ fontSize: 12, color: 'var(--txt3)' }}>Пропустить</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Смена пароля ─────────────────────────────────────────────────────────────
function ChangePasswordModal({ userId, onClose }) {
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  const save = async () => {
    setErr('');
    if (!oldPwd || !newPwd) return setErr('Заполни все поля');
    if (newPwd.length < 4) return setErr('Новый пароль минимум 4 символа');
    if (newPwd !== newPwd2) return setErr('Пароли не совпадают');
    try {
      await api.changePassword(userId, oldPwd, newPwd);
      setOk(true);
      setTimeout(onClose, 1500);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 380 }}>
        <div className="modal-header">
          <h2>🔑 Смена пароля</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        {ok ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--green-txt)', fontSize: 16, fontWeight: 600 }}>
            ✓ Пароль успешно изменён!
          </div>
        ) : (<>
          {[
            { l: 'Текущий пароль', v: oldPwd, s: setOldPwd },
            { l: 'Новый пароль',   v: newPwd, s: setNewPwd },
            { l: 'Повтори новый',  v: newPwd2, s: setNewPwd2 },
          ].map(f => (
            <div key={f.l} style={{ marginBottom: 12 }}>
              <label className="form-label">{f.l}</label>
              <input type="password" className="form-input" value={f.v}
                onChange={e => f.s(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()} />
            </div>
          ))}
          {err && <div style={{ color: 'var(--red-txt)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <button className="btn btn-primary btn-full" onClick={save}>Сохранить</button>
        </>)}
      </div>
    </div>
  );
}

// ── Главный компонент ─────────────────────────────────────────────────────────
export default function App() {
  const [user,    setUser]    = useState(() => {
    try { return JSON.parse(localStorage.getItem('wb_user') || 'null'); }
    catch { return null; }
  });
  const [users,   setUsers]   = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [cabs,    setCabs]    = useState([]);   // кабинеты текущего пользователя
  const [allCabs, setAllCabs] = useState([]);   // все кабинеты (для админа)
  const [history, setHist]    = useState([]);
  const [teams,   setTeams]   = useState([]);
  const [userGoals, setUserGoals] = useState([]); // [{user_id, month, goal}]
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
  const [adsRub,     setAdsRub]   = useState('');
  const [rows,       setRows]     = useState([]);
  const [saved,      setSaved]    = useState(false);
  const [revenueGoal, setRevenueGoal] = useState(() => +localStorage.getItem('wb_rev_goal') || 0);
  const [todayBanner, setTodayBanner] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('wb_theme') || 'dark');
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [comment, setComment] = useState('');
  const [onboardStep, setOnboardStep] = useState(() =>
    localStorage.getItem('wb_onboarded') ? -1 : 0
  );
  const [templates, setTemplates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wb_templates') || '[]'); } catch { return []; }
  });
  const [showTplModal, setShowTplModal] = useState(false);
  const [tplName, setTplName] = useState('');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('wb_theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const safe = (p, fallback) => p.catch(e => { console.warn('API error:', e.message); return fallback; });
    const curMonth = new Date().toISOString().slice(0, 7);
    Promise.all([
      safe(api.getCatalog(), []),
      safe(api.getCabs(), []),
      safe(api.getHistory(), []),
      safe(api.getUsers(), []),
      safe(api.getTeams(), []),
      safe(api.getUserGoals(curMonth), []),
      safe(api.getUserCabs(user.id), []),   // всегда грузим свежие кабинеты текущего пользователя
    ]).then(([cat, cabList, hist, userList, teamList, goalList, freshCabIds]) => {
      setCatalog(cat);
      setAllCabs(cabList);
      setHist(hist);
      setUsers(userList);
      setTeams(teamList);
      setUserGoals(goalList);
      // freshCabIds — актуальные ID кабинетов, даже если назначили после логина
      const myCabIds = user?.role === 'admin' ? cabList.map(c => c.id) : freshCabIds.map(id => +id);
      const visibleCabs = user?.role === 'admin' ? cabList
        : cabList.filter(c => myCabIds.includes(+c.id));
      setCabs(visibleCabs);
      const firstCab = visibleCabs[0] || (user?.role === 'admin' ? cabList[0] : null);
      if (firstCab) {
        setCab(firstCab.name);
        if (firstCab.buyout) setRet(+firstCab.buyout);
      }
      const draft = (() => { try { return JSON.parse(localStorage.getItem('wb_draft') || 'null'); } catch { return null; } })();
      if (draft) {
        if (draft.date)    setDate(draft.date);
        if (draft.revenue) setRev(draft.revenue);
        if (draft.adsRub)  setAdsRub(draft.adsRub);
        if (draft.rows?.length) setRows(draft.rows);
        else if (cat.length) setRows([mkRow(cat[0])]);
      } else if (cat.length) setRows([mkRow(cat[0])]);

      const today = new Date().toISOString().split('T')[0];
      const hasToday = hist.some(r => (r.date || '').startsWith(today) && r.user_login === (user?.login));
      if (!hasToday) setTodayBanner(true);

      fetchRate();
    }).finally(() => setLoading(false));
  }, [user]);

  const mkRow = prod => ({ id: Date.now() + Math.random(), product: prod.name, qty: '', cost: prod.cost, comm: prod.comm });
  const addRow = () => { if (catalog.length) setRows(r => [...r, mkRow(catalog[0])]); };

  // Автосохранение черновика
  useEffect(() => {
    if (!user) return;
    localStorage.setItem('wb_draft', JSON.stringify({ date, revenue, adsRub, rows }));
  }, [date, revenue, adsRub, rows]);

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
        profit: calc.profit, margin: calc.margin, drr: calc.drr, comment,
      });
      setHist(h => [rec, ...h]);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      setTodayBanner(false);
      setComment('');
      localStorage.removeItem('wb_draft');
    } catch (e) { alert('Ошибка: ' + e.message); }
  };

  const isAdmin = user?.role === 'admin';
  const NAV = [
    { k: 'calc',    l: 'Калькулятор' },
    { k: 'history', l: 'История' },
    { k: 'company', l: 'Компания' },
    { k: 'report',  l: 'Отчёт' },
    { k: 'teams',   l: 'Команды' },
    ...(isAdmin ? [{ k: 'admin', l: 'Администратор' }] : []),
  ];

  const saveTemplate = useCallback(() => {
    if (!tplName.trim() || !rows.length) return;
    const tpl = { id: Date.now(), name: tplName.trim(), rows: rows.map(r => ({ ...r, id: undefined })) };
    const updated = [...templates, tpl];
    setTemplates(updated);
    localStorage.setItem('wb_templates', JSON.stringify(updated));
    setTplName(''); setShowTplModal(false);
  }, [tplName, rows, templates]);

  const loadTemplate = useCallback((tpl) => {
    setRows(tpl.rows.map(r => ({ ...r, id: Date.now() + Math.random() })));
    setShowTplModal(false);
  }, []);

  const deleteTemplate = useCallback((id) => {
    const updated = templates.filter(t => t.id !== id);
    setTemplates(updated);
    localStorage.setItem('wb_templates', JSON.stringify(updated));
  }, [templates]);

  if (!user) return <LoginScreen onLogin={setUser} />;
  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      Загрузка данных...
    </div>
  );

  return (
    <div className="app-layout">
      {/* Онбординг */}
      {onboardStep >= 0 && onboardStep < ONBOARDING_STEPS.length && (
        <OnboardingOverlay
          step={onboardStep}
          total={ONBOARDING_STEPS.length}
          onNext={() => {
            const next = onboardStep + 1;
            if (next >= ONBOARDING_STEPS.length) {
              setOnboardStep(-1);
              localStorage.setItem('wb_onboarded', '1');
            } else {
              setOnboardStep(next);
            }
          }}
          onSkip={() => { setOnboardStep(-1); localStorage.setItem('wb_onboarded', '1'); }}
        />
      )}

      {/* Модалка шаблонов */}
      {showTplModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowTplModal(false)}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>📋 Шаблоны товаров</h2>
              <button className="modal-close" onClick={() => setShowTplModal(false)}>×</button>
            </div>
            {/* Сохранить текущие товары как шаблон */}
            <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
              <input className="form-input" value={tplName} onChange={e => setTplName(e.target.value)}
                placeholder="Название шаблона…" style={{ flex: 1 }}
                onKeyDown={e => e.key === 'Enter' && saveTemplate()} />
              <button className="btn btn-primary" onClick={saveTemplate}
                disabled={!tplName.trim() || !rows.length} style={{ whiteSpace: 'nowrap' }}>
                Сохранить текущие
              </button>
            </div>
            {templates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--txt3)', fontSize: 13 }}>
                Шаблонов пока нет.<br/>Добавь товары в калькуляторе и сохрани как шаблон.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {templates.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 10, background: 'var(--bg-card2)',
                    border: '1px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                        {t.rows.length} {t.rows.length === 1 ? 'товар' : t.rows.length < 5 ? 'товара' : 'товаров'}
                      </div>
                    </div>
                    <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }}
                      onClick={() => loadTemplate(t)}>Загрузить</button>
                    <button onClick={() => deleteTemplate(t.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--txt3)', fontSize: 18, padding: '0 4px', lineHeight: 1 }}
                      onMouseEnter={e => e.target.style.color = 'var(--red-txt)'}
                      onMouseLeave={e => e.target.style.color = 'var(--txt3)'}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
            <button className="btn" style={{ padding: '4px 8px', fontSize: 16 }} title="Сменить тему"
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setShowPwdModal(true)}>🔑</button>
            <button className="logout-btn" onClick={() => { localStorage.removeItem('wb_user'); setUser(null); setRows([]); setAppTab('calc'); }}>Выйти</button>
          </div>
        </div>
      </header>

      {/* Модалка смены пароля */}
      {showPwdModal && <ChangePasswordModal userId={user.id} onClose={() => setShowPwdModal(false)} />}

      <div className="app-content">

        {/* ── Калькулятор ── */}
        {appTab === 'calc' && (
          <div className="fade-in">
            {/* Баннер — сегодня не заполнено */}
            {todayBanner && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
                background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 10, padding: '10px 16px' }}>
                <span style={{ fontSize: 18 }}>⏰</span>
                <span style={{ fontSize: 13, color: 'var(--yellow-txt)', flex: 1 }}>Сегодня ещё нет записи — не забудь заполнить статистику</span>
                <button className="btn" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setTodayBanner(false)}>✕</button>
              </div>
            )}
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
                      <select value={cabinet} className="form-input" onChange={e => {
                        const name = e.target.value;
                        setCab(name);
                        const cab = (isAdmin ? allCabs : cabs).find(c => c.name === name);
                        if (cab?.buyout) setRet(+cab.buyout);
                      }}>
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
                  <div className="prod-row" style={{ marginBottom: 6, gridTemplateColumns: isAdmin ? '1fr 60px 90px 60px 60px 90px 32px' : '1fr 80px 32px' }}>
                    {(isAdmin
                      ? ['Товар', 'Кол.', 'Себес. ₸', 'Ком.', '₸/шт', 'Лог. итого', '']
                      : ['Товар', 'Кол.', '']
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
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={addRow}>
                      + Добавить товар
                    </button>
                    <button className="btn" style={{ padding: '0 14px', fontSize: 13 }} onClick={() => setShowTplModal(true)}
                      title="Шаблоны товаров">📋</button>
                  </div>
                </div>
              </div>

              {/* Результат */}
              <div>
                {/* Трекер плана */}
                {(() => {
                  const curMonth = new Date().toISOString().slice(0, 7);
                  const g = userGoals.find(x => x.user_id === user.id && x.month === curMonth);
                  const status = g ? calcPlanStatus(+g.goal, history, user.login, curMonth) : null;
                  return status ? <PlanTracker status={status} compact /> : null;
                })()}
                <ResultPanel c={calc} />
                <div style={{ marginTop: 10, marginBottom: 8 }}>
                  <input className="form-input" value={comment} onChange={e => setComment(e.target.value)}
                    placeholder="💬 Комментарий к записи (необязательно)" />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={save} className={`btn btn-lg btn-full ${saved ? 'btn-success' : 'btn-primary'}`}
                    style={{ flex: 1, transition: 'all 0.2s' }}>
                    {saved ? '✓ Сохранено!' : '💾 Сохранить запись'}
                  </button>
                  <button className="btn btn-lg" style={{ padding: '0 16px', flexShrink: 0 }}
                    title="Копировать результат"
                    onClick={() => {
                      const txt = [
                        `📅 ${date}  📦 ${cabinet}`,
                        `Выручка:  ${fmt(calc.rev)} ₸`,
                        `Реклама:  ${fmt(calc.ads)} ₸`,
                        `Прибыль:  ${fmt(calc.profit)} ₸`,
                        `Маржа:    ${fmtP(calc.margin)}%`,
                        `ДРР:      ${fmtP(calc.drr)}%`,
                      ].join('\n');
                      navigator.clipboard.writeText(txt).then(() => alert('Скопировано!'));
                    }}>📋</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {appTab === 'history' && (
          <HistoryPanel
            history={history} setHist={setHist} users={users} cabs={cabs}
            isAdmin={isAdmin} userLogin={user.login}
            onDelete={async id => { await api.deleteRecord(id); setHist(h => h.filter(r => r.id !== id)); }}
            onClear={async () => { await api.clearHistory(); setHist([]); }}
          />
        )}

        {appTab === 'company' && <CompanyDashboard history={history} users={users} cabs={cabs}
          revenueGoal={revenueGoal} setRevenueGoal={g => { setRevenueGoal(g); localStorage.setItem('wb_rev_goal', g); }}
          userGoals={userGoals} />}

        {appTab === 'report' && (
          <ReportPanel history={history} users={users} allCabs={allCabs}
            isAdmin={isAdmin} userLogin={user.login} />
        )}

        {appTab === 'teams' && (
          <TeamsPanel teams={teams} setTeams={setTeams} users={users} history={history} />
        )}

        {appTab === 'admin' && isAdmin && (
          <AdminPanel catalog={catalog} setCatalog={setCatalog}
            cabs={allCabs} setCabs={cab => { setAllCabs(cab); setCabs(cab); }}
            users={users} setUsers={setUsers} allCabs={allCabs}
            userGoals={userGoals} setUserGoals={setUserGoals} history={history} />
        )}
      </div>
    </div>
  );
}
