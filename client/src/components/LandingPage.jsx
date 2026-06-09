import { useState, useEffect } from 'react';
import { on, off, send } from '../ws';
import { signup, login, createRestaurant, fetchRestaurant, getToken } from '../auth';

export default function LandingPage({ onJoin }) {
  // home | start | join | confirm | pin-display (quick)  |  auth | name-restaurant | full-ready (full)
  const [view, setView] = useState('home');
  const [restaurantName, setRestaurantName] = useState('');
  const [pin, setPin] = useState('');
  const [foundRestaurant, setFoundRestaurant] = useState('');
  const [pendingSession, setPendingSession] = useState(null); // quick create: { serviceId, restaurantName, pin, mode }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Restaurant login state
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullRestaurant, setFullRestaurant] = useState(null); // { serviceId, pin, restaurantName }
  const [fullHeading, setFullHeading] = useState('Restaurant Ready');

  useEffect(() => {
    const onServiceFound = ({ restaurantName: name }) => {
      setFoundRestaurant(name);
      setError('');
      setLoading(false);
      setView('confirm');
    };
    const onServiceCreated = ({ serviceId, pin: p, restaurantName: name, mode }) => {
      setPendingSession({ serviceId, restaurantName: name, pin: p, mode });
      setLoading(false);
      setView('pin-display');
    };
    const onServiceJoined = ({ serviceId, restaurantName: name, mode }) => {
      setLoading(false);
      onJoin({ serviceId, restaurantName: name, mode });
    };
    const onServiceError = ({ message }) => {
      setError(message);
      setLoading(false);
    };

    on('service_found', onServiceFound);
    on('service_created', onServiceCreated);
    on('service_joined', onServiceJoined);
    on('service_error', onServiceError);
    return () => {
      off('service_found', onServiceFound);
      off('service_created', onServiceCreated);
      off('service_joined', onServiceJoined);
      off('service_error', onServiceError);
    };
  }, [onJoin]);

  const resetTo = (v) => { setView(v); setError(''); };

  // --- Quick Start (anonymous) ---
  const handleStart = (e) => {
    e.preventDefault();
    if (!restaurantName.trim()) return;
    setLoading(true);
    setError('');
    send('create_service', { restaurantName: restaurantName.trim() });
  };

  // --- Join (universal: works for quick or full services) ---
  const handleLookup = (e) => {
    e.preventDefault();
    if (pin.length !== 4) return;
    setLoading(true);
    setError('');
    send('lookup_service', { pin });
  };
  const handleConfirmJoin = () => {
    setLoading(true);
    send('join_service', { pin });
  };

  // Quick create: service already joined the WS room on creation, so enter directly.
  const handleEnterQuick = () => {
    if (pendingSession) onJoin(pendingSession);
  };

  // --- Restaurant login (manager) ---
  const handleRestaurantLogin = async () => {
    setError('');
    // Already logged in? Skip straight to their restaurant (or naming it).
    if (getToken()) {
      setLoading(true);
      const restaurant = await fetchRestaurant();
      setLoading(false);
      if (restaurant) {
        setFullRestaurant(restaurant);
        setFullHeading('Welcome Back');
        setView('full-ready');
      } else {
        setView('name-restaurant');
      }
      return;
    }
    setAuthMode('login');
    setUsername('');
    setPassword('');
    setView('auth');
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = authMode === 'signup'
        ? await signup(username.trim(), password)
        : await login(username.trim(), password);
      setLoading(false);
      if (data.restaurant) {
        setFullRestaurant(data.restaurant);
        setFullHeading('Welcome Back');
        setView('full-ready');
      } else {
        setView('name-restaurant');
      }
    } catch (err) {
      setLoading(false);
      setError(err.message);
    }
  };

  const handleCreateRestaurant = async (e) => {
    e.preventDefault();
    if (!restaurantName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const restaurant = await createRestaurant(restaurantName.trim());
      setLoading(false);
      setFullRestaurant(restaurant);
      setFullHeading('Restaurant Created');
      setView('full-ready');
    } catch (err) {
      setLoading(false);
      setError(err.message);
    }
  };

  // Full restaurant was created via REST, so join its WS room now by PIN.
  const handleEnterFull = () => {
    if (!fullRestaurant) return;
    setLoading(true);
    send('join_service', { pin: fullRestaurant.pin });
  };

  if (view === 'home') {
    return (
      <div className="landing">
        <div className="landing-card">
          <h1 className="landing-title">Kitchen Display System</h1>
          <p className="landing-subtitle">Start a new service or join an existing one</p>
          <div className="landing-actions">
            <button className="landing-btn landing-btn-primary" onClick={() => resetTo('start')}>
              Quick Start
            </button>
            <button className="landing-btn landing-btn-primary" onClick={handleRestaurantLogin}>
              Restaurant Login
            </button>
            <button className="landing-btn landing-btn-secondary" onClick={() => { setPin(''); resetTo('join'); }}>
              Join Service
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'start') {
    return (
      <div className="landing">
        <div className="landing-card">
          <button className="landing-back" onClick={() => resetTo('home')}>Back</button>
          <h2 className="landing-heading">Quick Start</h2>
          <p className="landing-subtitle">No setup, just tickets. Good for emergency scenarios.</p>
          <form onSubmit={handleStart}>
            <input
              className="landing-input"
              type="text"
              placeholder="Restaurant name"
              value={restaurantName}
              onChange={(e) => setRestaurantName(e.target.value)}
              autoFocus
            />
            {error && <p className="landing-error">{error}</p>}
            <button className="landing-btn landing-btn-primary" type="submit" disabled={loading || !restaurantName.trim()}>
              {loading ? 'Starting...' : 'Start'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'auth') {
    return (
      <div className="landing">
        <div className="landing-card">
          <button className="landing-back" onClick={() => resetTo('home')}>Back</button>
          <h2 className="landing-heading">{authMode === 'signup' ? 'Create Account' : 'Restaurant Login'}</h2>
          <p className="landing-subtitle">Save your menu, cook times for dishes, stations, and more.</p>
          <form onSubmit={handleAuth}>
            <input
              className="landing-input"
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
            <input
              className="landing-input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="landing-error">{error}</p>}
            <button className="landing-btn landing-btn-primary" type="submit" disabled={loading || !username.trim() || !password}>
              {loading ? 'Please wait...' : authMode === 'signup' ? 'Sign Up' : 'Log In'}
            </button>
          </form>
          <button
            className="landing-back"
            style={{ marginTop: '1rem' }}
            onClick={() => { setError(''); setAuthMode(authMode === 'signup' ? 'login' : 'signup'); }}
          >
            {authMode === 'signup' ? 'Have an account? Log in' : 'Need an account? Sign up'}
          </button>
        </div>
      </div>
    );
  }

  if (view === 'name-restaurant') {
    return (
      <div className="landing">
        <div className="landing-card">
          <button className="landing-back" onClick={() => resetTo('home')}>Back</button>
          <h2 className="landing-heading">Name Your Restaurant</h2>
          <p className="landing-subtitle">This is your saved restaurant.</p>
          <form onSubmit={handleCreateRestaurant}>
            <input
              className="landing-input"
              type="text"
              placeholder="Restaurant name"
              value={restaurantName}
              onChange={(e) => setRestaurantName(e.target.value)}
              autoFocus
            />
            {error && <p className="landing-error">{error}</p>}
            <button className="landing-btn landing-btn-primary" type="submit" disabled={loading || !restaurantName.trim()}>
              {loading ? 'Creating...' : 'Create'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'full-ready') {
    return (
      <div className="landing">
        <div className="landing-card">
          <h2 className="landing-heading">{fullHeading}</h2>
          <p className="landing-subtitle">{fullRestaurant?.restaurantName}: share this PIN with your team</p>
          <div className="pin-display">{fullRestaurant?.pin}</div>
          {error && <p className="landing-error">{error}</p>}
          <button className="landing-btn landing-btn-primary" onClick={handleEnterFull} disabled={loading}>
            {loading ? 'Entering...' : 'Enter KDS'}
          </button>
        </div>
      </div>
    );
  }

  if (view === 'pin-display') {
    return (
      <div className="landing">
        <div className="landing-card">
          <h2 className="landing-heading">Service Started</h2>
          <p className="landing-subtitle">Share this PIN with your team</p>
          <div className="pin-display">{pendingSession?.pin}</div>
          <button className="landing-btn landing-btn-primary" onClick={handleEnterQuick}>
            Enter KDS
          </button>
        </div>
      </div>
    );
  }

  if (view === 'join') {
    return (
      <div className="landing">
        <div className="landing-card">
          <button className="landing-back" onClick={() => { setPin(''); resetTo('home'); }}>Back</button>
          <h2 className="landing-heading">Join Service</h2>
          <form onSubmit={handleLookup}>
            <input
              className="landing-input landing-input-pin"
              type="text"
              inputMode="numeric"
              maxLength={4}
              placeholder="Enter PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            {error && <p className="landing-error">{error}</p>}
            <button className="landing-btn landing-btn-primary" type="submit" disabled={loading || pin.length !== 4}>
              {loading ? 'Looking up...' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'confirm') {
    return (
      <div className="landing">
        <div className="landing-card">
          <button className="landing-back" onClick={() => resetTo('join')}>Back</button>
          <h2 className="landing-heading">Join {foundRestaurant}?</h2>
          <div className="landing-actions">
            <button className="landing-btn landing-btn-primary" onClick={handleConfirmJoin} disabled={loading}>
              {loading ? 'Joining...' : 'Join'}
            </button>
            <button className="landing-btn landing-btn-secondary" onClick={() => resetTo('join')}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }
}
