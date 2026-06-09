import { useState, useEffect } from 'react';

// One ticking clock per card, shared by the elapsed timer and every fire countdown.
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function TicketCard({ ticket, onToggleItem, onClear, isCleared, onUnbump, onPrioritize, onTagItem }) {
  const allDone = ticket.items.every((item) => item.done);
  const now = useNow();
  const elapsed = formatElapsed(now - ticket.createdAt);

  const isWide = ticket.items.length > 5;
  const firstCol = isWide ? ticket.items.slice(0, 5) : ticket.items;
  const secondCol = isWide ? ticket.items.slice(5) : [];

  const renderItem = (item) => {
    const showFire = item.fireAt != null && !item.done && !isCleared;
    const firing = showFire && item.fireAt - now <= 0;
    return (
      <li
        key={item.id}
        className={`item ${item.done ? 'item-done' : 'item-pending'}${isCleared ? ' item-no-tap' : ''}${item.tagged ? ' item-tagged' : ''}`}
        onClick={() => !isCleared && onToggleItem(ticket.id, item.id)}
      >
        <span className="item-qty">×{item.quantity}</span>
        <span className="item-name">
          {item.name}
          {item.modifiers && item.modifiers.length > 0 && (
            <span className="item-modifiers">{item.modifiers.join(', ')}</span>
          )}
          {item.mods && <span className="item-mods">{item.mods}</span>}
        </span>
        {showFire && (
          <span className={`item-fire${firing ? ' firing' : ''}`}>
            {firing ? 'FIRE' : formatCountdown(item.fireAt - now)}
          </span>
        )}
        {!isCleared && (
          <button
            className="tag-btn"
            onClick={(e) => { e.stopPropagation(); onTagItem(ticket.id, item.id); }}
            aria-label="Tag item"
          >
            Tag
          </button>
        )}
        <span className="item-check">{item.done ? '✓' : ''}</span>
      </li>
    );
  };

  return (
    <div className={`ticket-card${allDone && !isCleared ? ' ticket-complete' : ''}${isCleared ? ' ticket-cleared' : ''}${ticket.prioritized ? ' ticket-prioritized' : ''}${isWide ? ' ticket-wide' : ''}`}>
      {ticket.prioritized && (
        <div className="priority-banner">PRIORITIZED</div>
      )}

      <div className="ticket-header">
        <span className="table-label">Table {ticket.table}</span>
        <div className="ticket-meta">
          <span className="fired-time">Fired {formatClock(ticket.createdAt)}</span>
          <span className="elapsed">{elapsed}</span>
          {ticket.predictedReadyAt != null && !isCleared && (
            <span className="predicted-ready">Ready ~{formatClock(ticket.predictedReadyAt)}</span>
          )}
        </div>
      </div>

      {isWide ? (
        <div className="item-columns">
          <ul className="item-list item-list-col">
            {firstCol.map(renderItem)}
          </ul>
          <ul className="item-list item-list-col item-list-col-right">
            {secondCol.map(renderItem)}
          </ul>
        </div>
      ) : (
        <ul className="item-list">
          {firstCol.map(renderItem)}
        </ul>
      )}

      {!isCleared && (
        <div className="ticket-actions">
          <button
            className={`prioritize-btn${ticket.prioritized ? ' active' : ''}`}
            onClick={() => onPrioritize(ticket.id)}
          >
            {ticket.prioritized ? 'Deprioritize' : 'Prioritize'}
          </button>
          {allDone && (
            <button className="clear-btn" onClick={() => onClear(ticket.id)}>
              Bump
            </button>
          )}
        </div>
      )}

      {isCleared && (
        <button className="unbump-btn" onClick={() => onUnbump(ticket.id)}>
          Unbump
        </button>
      )}
    </div>
  );
}
