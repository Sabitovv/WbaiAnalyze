function toDateKey(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { toDateKey };
