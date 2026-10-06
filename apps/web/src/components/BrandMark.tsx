import { useBrand } from '../lib/brand';
import { Logo } from './Icon';

/**
 * Marca no canto das telas. É o ÚNICO ponto onde o logotipo da empresa
 * entra: no lugar do símbolo do produto, sem mexer em nenhum outro elemento.
 * Sem logotipo (ou sem direito ao recurso) mostra o Estoque Simples.
 */
export function BrandMark({ size, name = true }: { size: number; name?: boolean }) {
  const brand = useBrand();
  if (brand?.logoUrl) {
    return <img className="brandlogo" src={brand.logoUrl} alt={brand.displayName ?? 'Logotipo da empresa'} style={{ height: size }} />;
  }
  return (
    <>
      <Logo size={size} />
      {name && 'Estoque Simples'}
    </>
  );
}
