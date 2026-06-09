import { useEffect, useState } from 'react';
import { on, off, send, setServiceId, clearServiceId } from './ws';
import { logout, getToken } from './auth';
import TicketForm from './components/TicketForm';
import TicketCard from './components/TicketCard';
import LandingPage from './components/LandingPage';
import MenuEditor from './components/MenuEditor';

export default function App() {
  const [session, setSession] = useState(null); // { serviceId, restaurantName, mode }
  const [tickets, setTickets] = useState([]);
  const [clearedTickets, setClearedTickets] = useState([]);
  const [menu, setMenu] = useState([]);
  const [editingMenu, setEditingMenu] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onInit = ({ tickets: active, clearedTickets: cleared, menu: m }) => {
      setTickets(active);
      setClearedTickets(cleared);
      setMenu(m || []);
    };
    const onMenuUpdated = ({ menu: m }) => setMenu(m || []);
    const onTicketCreated = (ticket) => setTickets((prev) => [...prev, ticket]);
    const onTicketUpdated = (updated) => setTickets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    const onTicketCleared = (ticket) => {
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
      setClearedTickets((prev) => [ticket, ...prev].slice(0, 30));
    };
    const onTicketUnbumped = (ticket) => {
      setClearedTickets((prev) => prev.filter((t) => t.id !== ticket.id));
      setTickets((prev) => [...prev, ticket]);
    };
    const onServiceEnded = () => {
      clearServiceId();
      setSession(null);
      setTickets([]);
      setClearedTickets([]);
      setMenu([]);
    };

    on('connect', onConnect);
    on('disconnect', onDisconnect);
    on('init', onInit);
    on('menu_updated', onMenuUpdated);
    on('ticket_created', onTicketCreated);
    on('ticket_updated', onTicketUpdated);
    on('ticket_cleared', onTicketCleared);
    on('ticket_unbumped', onTicketUnbumped);
    on('service_ended', onServiceEnded);

    return () => {
      off('connect', onConnect);
      off('disconnect', onDisconnect);
      off('init', onInit);
      off('menu_updated', onMenuUpdated);
      off('ticket_created', onTicketCreated);
      off('ticket_updated', onTicketUpdated);
      off('ticket_cleared', onTicketCleared);
      off('ticket_unbumped', onTicketUnbumped);
      off('service_ended', onServiceEnded);
    };
  }, []);

  const handleJoin = (newSession) => {
    setServiceId(newSession.serviceId);
    setSession(newSession);
  };

  const createTicket = (table, items) => send('create_ticket', { table, items });
  const toggleItem = (ticketId, itemId) => send('toggle_item', { ticketId, itemId });
  const clearTicket = (ticketId) => send('clear_ticket', { ticketId });
  const unbumpTicket = (ticketId) => send('unbump_ticket', { ticketId });
  const prioritizeTicket = (ticketId) => send('prioritize_ticket', { ticketId });
  const tagItem = (ticketId, itemId) => send('tag_item', { ticketId, itemId });

  const endService = () => {
    if (!window.confirm('Are you sure that you would like to end service? This will clear all active and recent tickets for everyone.')) return;
    send('end_service', {});
  };

  // A logged-in restaurant: leaving must NOT delete the saved restaurant.
  // Just drop the local session (and log out the account if signed in on this device).
  const leaveRestaurant = async () => {
    clearServiceId();
    await logout();
    setSession(null);
    setTickets([]);
    setClearedTickets([]);
  };

  const sortedTickets = [...tickets].sort((a, b) => {
    if (a.prioritized && !b.prioritized) return -1;
    if (!a.prioritized && b.prioritized) return 1;
    return a.createdAt - b.createdAt;
  });

  if (!session) {
    return <LandingPage onJoin={handleJoin} />;
  }

  return (
    <div className="app">
      {editingMenu && <MenuEditor onClose={() => setEditingMenu(false)} />}
      <header className="app-header">
        <h1>{session.restaurantName}</h1>
        <div className="header-actions">
          {session.mode === 'full' && getToken() && (
            <button className="menu-edit-btn" onClick={() => setEditingMenu(true)}>
              Edit Menu
            </button>
          )}
          {session.mode === 'full' ? (
            <button className="end-service-btn" onClick={leaveRestaurant}>
              {getToken() ? 'Log Out' : 'Leave'}
            </button>
          ) : (
            <button className="end-service-btn" onClick={endService}>
              End Service
            </button>
          )}
          <span className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
      </header>
      <div className="app-body">
        <aside className="form-panel">
          <TicketForm onSubmit={createTicket} menu={session.mode === 'full' ? menu : []} />
        </aside>
        <main className="tickets-panel">
          {sortedTickets.length === 0 && clearedTickets.length === 0 ? (
            <div className="empty-state">No active tickets</div>
          ) : (
            <>
              {sortedTickets.length > 0 && (
                <div className="tickets-grid">
                  {sortedTickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      onToggleItem={toggleItem}
                      onClear={clearTicket}
                      onPrioritize={prioritizeTicket}
                      onTagItem={tagItem}
                    />
                  ))}
                </div>
              )}
              {clearedTickets.length > 0 && (
                <div className="cleared-section">
                  <div className="cleared-section-label">Recently Cleared</div>
                  <div className="tickets-grid">
                    {clearedTickets.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        onToggleItem={() => {}}
                        isCleared
                        onUnbump={unbumpTicket}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
