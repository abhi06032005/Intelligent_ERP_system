import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppNotification, Lookups } from '@loomos/shared';
import { toast } from 'sonner';
import { api } from '../services/api';

export function useData<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path),
    enabled,
  });
}

export const useLookups = () => useData<Lookups>('/lookups');

export function useAction() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ path, body = {} }: { path: string; body?: unknown }) =>
      api(path, body),
    onSuccess: () => {
      void client.invalidateQueries();
      toast.success('Factory workspace updated');
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
}

// Keeps every open screen in sync: when anyone changes something, the server
// sends a small event and we refresh all loaded data.
export function useLiveUpdates() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Short delay on initial mount to allow backend API server to finish booting
    const startDelay = setTimeout(() => {
      source = new EventSource('/api/v1/events', { withCredentials: true });

      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);

      source.onmessage = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void client.invalidateQueries(), 250);
      };
    }, 400);

    return () => {
      clearTimeout(startDelay);
      clearTimeout(timer);
      source?.close();
    };
  }, [client]);

  return connected;
}

// Waits until the user stops typing before a value is used (keeps search from firing on every key).
export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// Stored notifications for the signed-in user. Simple polling every 30 seconds:
// no sockets to run, and it keeps working behind any proxy.
export function useNotificationFeed() {
  const client = useQueryClient();
  const feed = useQuery({
    queryKey: ['/notifications/feed'],
    queryFn: () => api<{ items: AppNotification[]; unread: number }>('/notifications/feed'),
    refetchInterval: 30000,
  });

  const markRead = useMutation({
    mutationFn: (id?: string) => api(id ? `/notifications/${id}/read` : '/notifications/read-all', {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['/notifications/feed'] }),
  });

  // Toast each notification the first time it shows up while the app is open.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = feed.data?.items;
    if (!items) return;
    if (seen.current) {
      for (const n of items) {
        if (!n.read && !seen.current.has(n.id)) toast.info(n.title, { description: n.message });
      }
    }
    seen.current = new Set(items.map((n) => n.id));
  }, [feed.data]);

  return { feed, markRead };
}
