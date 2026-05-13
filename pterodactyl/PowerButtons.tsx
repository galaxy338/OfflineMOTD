/**
 * OfflineMOTD — Modified Pterodactyl PowerButtons.tsx
 * 
 * This replaces the original PowerButtons.tsx in the Pterodactyl panel source:
 *   resources/scripts/components/server/console/PowerButtons.tsx
 * 
 * WHAT IT CHANGES:
 *   When the user clicks "Start", instead of sending the start command
 *   directly via WebSocket, it first calls OfflineMOTD's API:
 *     POST http://{ALWAYSMOTD_URL}/api/power/{serverUuid}/start
 * 
 *   OfflineMOTD then:
 *     1. Stops the fake MOTD server (releases the port)
 *     2. Sends the actual start signal to Pterodactyl via Client API
 * 
 *   All other power actions (stop, restart, kill) work normally via WebSocket.
 * 
 * HOW TO INSTALL:
 *   1. Replace the original file at:
 *      pterodactyl/panel/resources/scripts/components/server/console/PowerButtons.tsx
 *   2. Update ALWAYSMOTD_URL below to point to your OfflineMOTD instance
 *   3. Rebuild the panel frontend:
 *      cd /var/www/pterodactyl
 *      yarn install
 *      yarn build:production
 */

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/elements/button/index';
import Can from '@/components/elements/Can';
import { ServerContext } from '@/state/server';
import { PowerAction } from '@/components/server/console/ServerConsoleContainer';
import { Dialog } from '@/components/elements/dialog';

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION — Update this to your OfflineMOTD instance URL
// ══════════════════════════════════════════════════════════════
const ALWAYSMOTD_URL = '/motd-api';
// ══════════════════════════════════════════════════════════════

interface PowerButtonProps {
    className?: string;
}

export default ({ className }: PowerButtonProps) => {
    const [open, setOpen] = useState(false);
    const [starting, setStarting] = useState(false);
    const status = ServerContext.useStoreState((state) => state.status.value);
    const instance = ServerContext.useStoreState((state) => state.socket.instance);
    const uuid = ServerContext.useStoreState((state) => state.server.data?.uuid);

    const killable = status === 'stopping';

    const onButtonClick = (
        action: PowerAction | 'kill-confirmed',
        e: React.MouseEvent<HTMLButtonElement, MouseEvent>
    ): void => {
        e.preventDefault();

        if (action === 'kill') {
            return setOpen(true);
        }

        // ─── ALWAYSMOTD INTERCEPT ───────────────────────────────
        // When "Start" is clicked, call OfflineMOTD to release the
        // port and start the server via API instead of WebSocket
        if (action === 'start' && uuid) {
            setStarting(true);
            fetch(`${ALWAYSMOTD_URL}/api/power/${uuid}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            })
                .then((res) => res.json())
                .then((data) => {
                    console.log('[OfflineMOTD] Server start initiated:', data);
                    setStarting(false);
                })
                .catch((err) => {
                    console.error('[OfflineMOTD] Failed to reach OfflineMOTD, falling back to direct start:', err);
                    // Fallback: start directly via WebSocket if OfflineMOTD is unreachable
                    if (instance) {
                        instance.send('set state', 'start');
                    }
                    setStarting(false);
                });
            return;
        }
        // ─── END ALWAYSMOTD INTERCEPT ───────────────────────────

        if (instance) {
            setOpen(false);
            instance.send('set state', action === 'kill-confirmed' ? 'kill' : action);
        }
    };

    useEffect(() => {
        if (status === 'offline') {
            setOpen(false);
        }
    }, [status]);

    return (
        <div className={className}>
            <Dialog.Confirm
                open={open}
                hideCloseIcon
                onClose={() => setOpen(false)}
                title={'Forcibly Stop Process'}
                confirm={'Continue'}
                onConfirmed={onButtonClick.bind(this, 'kill-confirmed')}
            >
                Forcibly stopping a server can lead to data corruption.
            </Dialog.Confirm>
            <Can action={'control.start'}>
                <Button
                    className={'flex-1'}
                    disabled={status !== 'offline' || starting}
                    onClick={onButtonClick.bind(this, 'start')}
                >
                    {starting ? 'Starting...' : 'Start'}
                </Button>
            </Can>
            <Can action={'control.restart'}>
                <Button.Text className={'flex-1'} disabled={!status} onClick={onButtonClick.bind(this, 'restart')}>
                    Restart
                </Button.Text>
            </Can>
            <Can action={'control.stop'}>
                <Button.Danger
                    className={'flex-1'}
                    disabled={status === 'offline'}
                    onClick={onButtonClick.bind(this, killable ? 'kill' : 'stop')}
                >
                    {killable ? 'Kill' : 'Stop'}
                </Button.Danger>
            </Can>
        </div>
    );
};
