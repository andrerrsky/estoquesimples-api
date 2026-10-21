import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { fold } from '../lib/format';
import { Icon } from './Icon';
import '../styles/suggest-input.css';

/**
 * Campo de texto livre com sugestões (categoria, fornecedor, unidade,
 * localização), igual ao do app Android: a lista abre ao tocar, filtra sem
 * diferenciar acentos e maiúsculas, e a seta mostra tudo.
 *
 * Substitui o `<datalist>`, que no Safari do iPhone quase não aparece (só
 * na barra do teclado, e às vezes nem isso): quem usava o web app no celular
 * não via as categorias já cadastradas e acabava criando "Bebida",
 * "bebidas" e "Bebídas".
 */
export function SuggestInput({
  value,
  onChange,
  options,
  maxLength,
  placeholder,
  invalid,
  inputMode,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  maxLength?: number;
  placeholder?: string;
  invalid?: boolean;
  inputMode?: 'text' | 'decimal';
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(-1);

  const matches = useMemo(() => {
    const query = fold(value.trim());
    const unique = [...new Set(options.filter((option) => option.trim() !== ''))];
    // O valor já escolhido não precisa aparecer de novo como sugestão.
    const filtered = showAll || !query ? unique : unique.filter((option) => fold(option).includes(query));
    return filtered.filter((option) => option !== value).slice(0, 50);
  }, [options, value, showAll]);

  const visible = open && matches.length > 0;

  const choose = (option: string) => {
    onChange(option);
    setOpen(false);
    setShowAll(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && visible && active >= 0 && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === 'Escape' && visible) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="suggest">
      <input
        ref={inputRef}
        className="input suggest__input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setShowAll(false);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        // Um instante para o toque na sugestão chegar antes de a lista sumir.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        maxLength={maxLength}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={listId}
        aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="suggest__toggle"
          tabIndex={-1}
          aria-label="Ver opções"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            // O campo é filho de um <label>: o clique não pode "atravessar".
            event.preventDefault();
            setShowAll(true);
            setOpen((current) => !(current && showAll));
            inputRef.current?.focus();
          }}
        >
          <Icon name="chevronDown" size={18} />
        </button>
      )}
      {visible && (
        <ul className="suggest__list" id={listId} role="listbox">
          {matches.map((option, index) => (
            <li
              key={option}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`suggest__option${index === active ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
