/**
 * Component: Library Settings Tab (Main)
 * Documentation: documentation/settings-pages.md
 */

import { Settings } from '../../lib/types';
import { useLibrarySettings } from './useLibrarySettings';
import { PlexSection } from './PlexSection';
import { AudiobookshelfSection } from './AudiobookshelfSection';
import { SkipListSection } from './SkipListSection';

interface LibraryTabProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onValidationChange: (section: string, isValid: boolean) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export function LibraryTab({
  settings,
  onChange,
  onValidationChange,
  onSuccess,
  onError,
}: LibraryTabProps) {
  const {
    plexLibraries,
    testingPlex,
    plexTestResult,
    testPlexConnection,
    absLibraries,
    testingAbs,
    absTestResult,
    testABSConnection,
  } = useLibrarySettings(onSuccess, onError, onValidationChange);

  const handleTestPlexConnection = () => {
    testPlexConnection(settings.plex.url, settings.plex.token);
  };

  const handleTestABSConnection = () => {
    testABSConnection(settings.audiobookshelf.serverUrl, settings.audiobookshelf.apiToken);
  };

  // Render appropriate section based on backend mode
  if (settings.backendMode === 'plex') {
    return (
      <>
      <PlexSection
        settings={settings}
        onChange={onChange}
        onValidationChange={onValidationChange}
        libraries={plexLibraries}
        testing={testingPlex}
        testResult={plexTestResult}
        onTestConnection={handleTestPlexConnection}
      />
      <SkipListSection />
      </>
    );
  }

  if (settings.backendMode === 'audiobookshelf') {
    return (
      <>
      <AudiobookshelfSection
        settings={settings}
        onChange={onChange}
        onValidationChange={onValidationChange}
        libraries={absLibraries}
        testing={testingAbs}
        testResult={absTestResult}
        onTestConnection={handleTestABSConnection}
      />
      <SkipListSection />
      </>
    );
  }

  // Fallback (shouldn't happen)
  return (
    <div className="text-center py-8">
      <p className="text-gray-500">Invalid backend mode. Please configure your backend in setup.</p>
    </div>
  );
}
