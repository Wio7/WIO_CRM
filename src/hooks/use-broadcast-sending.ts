'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  createServerBroadcast,
  type AudienceConfig,
} from '@/lib/whatsapp/broadcast-audience';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';
import type { MessageTemplate } from '@/types';

export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/whatsapp/broadcast-audience';
export type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Stored on the broadcast and applied by the server dispatcher.
   */
  headerMediaUrl?: string;
  /** Send at this moment; omit (or pass a past/now date) to send now. */
  scheduledAt?: Date;
}

interface UseBroadcastSendingReturn {
  /**
   * Saves the broadcast and its recipients and queues it for the
   * server (GET /api/broadcasts/cron). The browser never sends, so
   * "send now" and "schedule" take exactly the same path. Resolves
   * with the new broadcast id.
   */
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      const supabase = createClient();
      // broadcasts.user_id is NOT NULL + guarded by RLS.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('No has iniciado sesión.');
      if (!accountId) throw new Error('Tu perfil no está vinculado a una cuenta.');

      return await createServerBroadcast(
        supabase,
        { accountId, userId: user.id },
        {
          name: payload.name,
          template: payload.template,
          audience: payload.audience,
          variables: payload.variables,
          headerMediaUrl: payload.headerMediaUrl,
          scheduledAt: payload.scheduledAt ?? new Date(),
        },
        setProgress,
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
