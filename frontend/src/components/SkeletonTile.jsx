/** Esqueletos de carga. Reservan el alto real para que nada salte al llegar los datos. */
export function SkeletonTile({ lines = 3, height = 148, title = true }) {
  return (
    <div className="tile" aria-hidden="true" style={{ minHeight: height }}>
      {title && <div className="skeleton" style={{ height: 14, width: '42%', marginBottom: 16 }} />}
      <div className="skeleton" style={{ height: 30, width: '58%', marginBottom: 14 }} />
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className="skeleton"
          style={{ height: 10, width: `${88 - index * 13}%`, marginBottom: 9 }}
        />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 4, ...rest }) {
  return (
    <div className="grid grid-auto">
      {Array.from({ length: count }).map((_, index) => <SkeletonTile key={index} {...rest} />)}
    </div>
  );
}

export function SkeletonRows({ rows = 6 }) {
  return (
    <div aria-hidden="true" className="stack" style={{ gap: 'var(--sp-2)' }}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height: 38 }} />
      ))}
    </div>
  );
}

export default SkeletonTile;
