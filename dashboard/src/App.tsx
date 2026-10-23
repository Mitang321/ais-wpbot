import { useEffect, useState } from 'react';
import { hasToken, logout, setUnauthorizedHandler } from './api';
import { Login } from './components/Login';
import { Inbox } from './components/Inbox';

export default function App(): JSX.Element {
  const [authed, setAuthed] = useState(hasToken());
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setExpired(true);
      setAuthed(false);
    });
  }, []);

  if (!authed) {
    return (
      <Login
        notice={expired ? 'Your session expired. Please sign in again.' : undefined}
        onSuccess={() => {
          setExpired(false);
          setAuthed(true);
        }}
      />
    );
  }
  return (
    <Inbox
      onLogout={() => {
        logout();
        setAuthed(false);
      }}
    />
  );
}
