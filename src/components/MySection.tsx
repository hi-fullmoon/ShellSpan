import { useAppStore } from '../stores/appStore';
import { useRecentConnectionsStore } from '../stores/recentConnectionsStore';
import { MySidebar } from './MySidebar';
import { SavedConnectionsPanel } from './SavedConnectionsPanel';
import { RecentConnectionsPanel } from './RecentConnectionsPanel';
import { KeychainPanel } from './KeychainPanel';
import { PortForwardsPanel } from './PortForwardsPanel';
import { KnownHostsPanel } from './KnownHostsPanel';
import { LogsPanel } from './LogsPanel';
import { SnippetsPanel } from './SnippetsPanel';
import type { ConnectionProfile, MyMenuKey, RecentConnection } from '../types';

interface MySectionProps {
  savedProfiles: ConnectionProfile[];
  onConnectProfile: (profile: ConnectionProfile) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onDeleteProfile: (profileId: string) => void;
  onTogglePinProfile: (profileId: string) => void;
  onToggleFavoriteProfile: (profileId: string) => void;
  onRenameProfile: (profileId: string, name: string) => void;
  onOpenConnectDialog: () => void;
  onSendSnippetCommand: (command: string) => void;
}

export function MySection({
  savedProfiles,
  onConnectProfile,
  onEditProfile,
  onDeleteProfile,
  onTogglePinProfile,
  onToggleFavoriteProfile,
  onRenameProfile,
  onOpenConnectDialog,
  onSendSnippetCommand,
}: MySectionProps) {
  const myActiveMenu = useAppStore((state) => state.myActiveMenu);
  const setMyActiveMenu = useAppStore((state) => state.setMyActiveMenu);
  const recentItems = useRecentConnectionsStore((state) => state.items);
  const removeRecent = useRecentConnectionsStore((state) => state.remove);
  const clearRecent = useRecentConnectionsStore((state) => state.clear);

  const handleRecentConnect = (item: RecentConnection) => {
    const profile: ConnectionProfile = {
      id: item.id,
      name: item.name || `${item.username}@${item.host}`,
      host: item.host,
      port: item.port,
      username: item.username,
      authMethod: item.authMethod,
      privateKeyPath: item.privateKeyPath,
    };
    onConnectProfile(profile);
  };

  const renderPanel = () => {
    switch (myActiveMenu) {
      case 'savedConnections':
        return (
          <SavedConnectionsPanel
            profiles={savedProfiles}
            onConnect={onConnectProfile}
            onDelete={onDeleteProfile}
            onEdit={onEditProfile}
            onNewHost={onOpenConnectDialog}
            onRename={onRenameProfile}
            onToggleFavorite={onToggleFavoriteProfile}
            onTogglePin={onTogglePinProfile}
          />
        );
      case 'recentConnections':
        return (
          <RecentConnectionsPanel
            items={recentItems}
            onClear={clearRecent}
            onConnect={handleRecentConnect}
            onRemove={removeRecent}
          />
        );
      case 'keychain':
        return <KeychainPanel />;
      case 'portForwards':
        return <PortForwardsPanel profiles={savedProfiles} />;
      case 'snippets':
        return <SnippetsPanel onSendCommand={onSendSnippetCommand} />;
      case 'knownHosts':
        return <KnownHostsPanel />;
      case 'logs':
        return <LogsPanel />;
      default:
        return null;
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-1">
      <MySidebar activeMenu={myActiveMenu} onMenuChange={setMyActiveMenu} />
      <div className="min-h-0 min-w-0 flex-1">{renderPanel()}</div>
    </section>
  );
}
