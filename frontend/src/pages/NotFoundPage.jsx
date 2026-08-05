/** 404 del router. */
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

export function NotFoundPage() {
  return (
    <div className="cp-state">
      <Compass size={34} aria-hidden="true" className="text-subtle" />
      <p className="cp-state-title">Esa direccion no existe</p>
      <p className="cp-state-msg">Puede que el enlace este mal escrito o que la seccion se haya movido.</p>
      <Link className="btn btn-sm" to="/resumen">Ir al resumen</Link>
    </div>
  );
}

export default NotFoundPage;
