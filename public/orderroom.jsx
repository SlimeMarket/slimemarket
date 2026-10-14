// ============ View 3: Order Room & Dispute ============

function Stepper({ status }) {
  const flow = ['PENDING', 'PROCESS', 'SENT', 'DONE'];
  const disputed = status === 'DISPUTED';
  const idx = disputed ? 2 : flow.indexOf(status);
  return (
    <div className="flex items-center">
      {flow.map((s, i) => {
        const done = i < idx || (status === 'DONE' && i <= idx);
        const active = i === idx && !disputed;
        const isLast = i === flow.length - 1;
        const lastIsDispute = isLast && disputed;
        const m = STATUS_META[lastIsDispute ? 'DISPUTED' : s];
        const label = lastIsDispute ? 'DISPUTED' : s;
        const reached = done || active || (lastIsDispute);
        const ring = lastIsDispute ? 'bg-rose-500/20 ring-rose-500 text-rose-300'
          : done ? 'bg-emerald-500/20 ring-emerald-500 text-emerald-300'
          : active ? 'bg-arc-primary/20 ring-arc-primary text-arc-accent pulse-glow'
          : 'bg-arc-surface2/60 ring-arc-borderlt text-arc-faint';
        return (
          <React.Fragment key={s}>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div className={`w-10 h-10 rounded-xl ring-2 flex items-center justify-center transition-all ${ring}`}>
                <Icon name={m.icon} size={17} />
              </div>
              <span className={`font-pixel text-[7px] ${reached ? (lastIsDispute ? 'text-rose-300' : done ? 'text-emerald-300' : 'text-arc-accent') : 'text-arc-faint'}`}>{label}</span>
            </div>
            {!isLast && <div className={`h-0.5 flex-1 mx-1 sm:mx-2 rounded-full mb-5 ${i < idx ? 'bg-emerald-500/50' : 'bg-arc-surface2'}`}></div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ChatBubble({ c, me = 'buyer' }) {
  if (c.from === 'system')
    return <div className="flex justify-center"><span className="text-[11px] text-arc-faint bg-arc-surface2/50 rounded-full px-3 py-1 inline-flex items-center gap-1.5"><Icon name="info" size={11} /> {c.text} · {c.time}</span></div>;
  const mine = c.from === me;
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${mine ? 'bg-arc-primary text-white rounded-br-md' : 'bg-arc-surface2 text-arc-text rounded-bl-md'}`}>
        <div style={{ textWrap: 'pretty' }}>{c.text}</div>
        <div className={`text-[10px] mt-1 ${mine ? 'text-white/70' : 'text-arc-faint'}`}>{c.time}</div>
      </div>
    </div>
  );
}

// ---------- Appeal / Dispute Modal ----------
function AppealModal({ open, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [chronology, setChronology] = useState('');
  const reasons = [tr('or.reason1',"Item doesn't match description"), tr('or.reason2',"Wrong credentials / can't log in"), tr('or.reason3','Seller unresponsive'), tr('or.reason4','Account recovered / clawed back')];

  return (
    <Modal open={open} onClose={onClose} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border bg-rose-500/5">
          <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center text-rose-300"><Icon name="gavel" size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{tr('or.appealTitle','File Dispute (Appeal)')}</div>
            <div className="text-xs text-arc-muted">{tr('or.appealSub','Order status changes immediately to')} → <span className="font-pixel text-[8px] text-rose-300">DISPUTED</span></div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('or.reasonLabel','Dispute Reason')}</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {reasons.map(r => (
                <button key={r} onClick={() => setReason(r)}
                  className={`text-xs rounded-lg px-2.5 py-1.5 transition ${reason === r ? 'bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/50' : 'bg-arc-surface2/60 text-arc-muted ring-1 ring-arc-borderlt/60 hover:ring-arc-borderlt'}`}>{r}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('or.chronology','Chronology Details')}</label>
            <textarea rows={3} value={chronology} onChange={e => setChronology(e.target.value)} placeholder={tr('or.chronologyPh','Describe what happened…')}
              className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-rose-500/40 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition"></textarea>
          </div>
          {/* Evidence upload is intentionally unavailable: there is no upload
              endpoint yet, so we don't pretend to attach files. */}
          <div>
            <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('or.evidence','Screenshot Evidence')}</label>
            <div className="mt-2 w-full border-2 border-dashed border-arc-border rounded-xl py-5 flex flex-col items-center gap-2 text-arc-faint">
              <Icon name="image-up" size={22} className="text-arc-faint" />
              <span className="text-xs text-center px-4 leading-relaxed">{tr('or.evidenceUnavailable','Evidence upload is not available yet — please describe everything in the chronology above.')}</span>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="danger" full icon="gavel" disabled={!reason} onClick={() => onSubmit(reason, chronology)}>{tr('or.sendTribunal','Send to Tribunal')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}

Object.assign(window, { AppealModal, Stepper, ChatBubble });
