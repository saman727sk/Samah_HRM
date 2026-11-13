/* eslint-disable react/only-export-components */
/**
 * App-wide confirmation dialog, used before actions that are hard to undo
 * or affect other people:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Stop this loan?', message: '…', confirmLabel: 'Stop loan', danger: true }))) return;
 *
 * Options: title, message (text or JSX), items (bullet list of consequences),
 * confirmLabel, cancelLabel, danger (red button; Cancel gets the focus), and
 * typeToConfirm (the user must type this word, for the most serious actions).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal } from './ui.jsx';

const ConfirmContext = createContext(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [ask, setAsk] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setAsk({ ...opts, resolve })), []);
  const close = (answer) => { ask?.resolve(answer); setAsk(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {ask && <ConfirmDialog {...ask} onAnswer={close} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ title, message, items, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, typeToConfirm, onAnswer }) {
  const [typed, setTyped] = useState('');
  const safeRef = useRef(null);
  // A dangerous action never happens on a stray Enter: Cancel is focused first.
  useEffect(() => { if (danger) safeRef.current?.querySelector('button')?.focus(); }, [danger]);
  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();
  return (
    <Modal title={title} onClose={() => onAnswer(false)}
      footer={<>
        <span ref={safeRef}><Button onClick={() => onAnswer(false)}>{cancelLabel}</Button></span>
        <Button kind={danger ? 'danger' : 'primary'} disabled={!ready} onClick={() => onAnswer(true)} autoFocus={!danger}>{confirmLabel}</Button>
      </>}>
      <div className="stack">
        {message && (danger ? <Alert kind="warn">{message}</Alert> : <div>{message}</div>)}
        {items?.length > 0 && <ul style={{ margin: 0, paddingInlineStart: 20 }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        {typeToConfirm && (
          <Input label={<>Type <strong>{typeToConfirm}</strong> to confirm</>} value={typed} autoFocus onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) onAnswer(true); }} />
        )}
      </div>
    </Modal>
  );
}
