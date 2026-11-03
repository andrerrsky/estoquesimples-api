import { Icon, type IconName } from './Icon';

/** Perfis do Estoque Simples nas redes. Um lugar só: os dois rodapés usam esta lista. */
export const SOCIAL_LINKS: Array<{ label: string; href: string; icon: IconName }> = [
  { label: 'Instagram', href: 'https://www.instagram.com/estoquesimplesapp', icon: 'instagram' },
  { label: 'Facebook', href: 'https://www.facebook.com/share/1Ew1KKeopW/?mibextid=wwXIfr', icon: 'facebook' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/estoque-simples/', icon: 'linkedin' },
];

/** Ícones das redes para o rodapé. O nome fica só para leitores de tela. */
export function SocialLinks() {
  return (
    <nav className="social-links" aria-label="Redes sociais">
      {SOCIAL_LINKS.map((item) => (
        <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer" aria-label={`${item.label} do Estoque Simples`} title={item.label}>
          <Icon name={item.icon} size={20} />
        </a>
      ))}
    </nav>
  );
}
