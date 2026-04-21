/**
 * Component: Path Mapping Helper
 * Documentation: documentation/deployment/volume-mapping.md
 *
 * Public, unprotected page that guides users through configuring
 * Docker volume mappings for their download clients and RMAB.
 * Purely client-side — no API calls, no real data access.
 */

'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  CLIENT_DISPLAY_NAMES,
  CLIENT_PROTOCOL_MAP,
  type DownloadClientType,
} from '@/lib/interfaces/download-client.interface';

// =========================================================================
// TYPES
// =========================================================================

interface ClientConfig {
  type: DownloadClientType;
  /** The path inside the download client container where completed downloads land */
  savePath: string;
  /** The volume mapping from the client's docker-compose (host:container) — host side */
  hostPath: string;
  /** The volume mapping from the client's docker-compose (host:container) — container side */
  containerMountPath: string;
  /** Whether this client needs remote path mapping */
  remotePathMapping: boolean;
  /** The path as seen by the remote download client (for remote path mapping) */
  remotePath: string;
}

type Step = 'clients' | 'save-paths' | 'host-paths' | 'results';

const STEPS: { key: Step; title: string }[] = [
  { key: 'clients', title: 'Clients' },
  { key: 'save-paths', title: 'Save Paths' },
  { key: 'host-paths', title: 'Volume Mapping' },
  { key: 'results', title: 'Results' },
];

const ALL_CLIENTS: DownloadClientType[] = ['qbittorrent', 'transmission', 'deluge', 'sabnzbd', 'nzbget'];

const DEFAULT_SAVE_PATHS: Record<DownloadClientType, string> = {
  qbittorrent: '/downloads',
  transmission: '/downloads/complete',
  deluge: '/downloads',
  sabnzbd: '/downloads/complete',
  nzbget: '/downloads/completed',
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================

/**
 * Find the longest common path prefix across multiple paths.
 * Only meaningful when there are multiple DIFFERENT paths.
 */
function findCommonRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0];

  const unique = [...new Set(paths)];
  if (unique.length === 1) return unique[0];

  // Split each path into segments
  const segmentArrays = unique.map((p) => p.replace(/\/+$/, '').split('/').filter(Boolean));
  const minLength = Math.min(...segmentArrays.map((s) => s.length));

  const commonSegments: string[] = [];
  for (let i = 0; i < minLength; i++) {
    const segment = segmentArrays[0][i];
    if (segmentArrays.every((s) => s[i] === segment)) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return '/';
  return '/' + commonSegments.join('/');
}

/**
 * Get the relative path from a root to a full path.
 * Returns empty string if they're the same.
 */
function getRelativePath(root: string, fullPath: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  const normalizedFull = fullPath.replace(/\/+$/, '');

  if (normalizedRoot === normalizedFull) return '';

  if (normalizedFull.startsWith(normalizedRoot + '/')) {
    return normalizedFull.slice(normalizedRoot.length + 1);
  }

  // Shouldn't happen if common root is correct, but fallback
  return normalizedFull;
}

/**
 * Find the common root of the host paths to build the RMAB volume mapping.
 * Maps from the host path hierarchy to the container path hierarchy.
 */
function findHostCommonRoot(configs: ClientConfig[]): string {
  const hostPaths = configs.map((c) => c.hostPath);
  if (hostPaths.length === 0) return '';
  if (hostPaths.length === 1) return hostPaths[0];

  const unique = [...new Set(hostPaths)];
  if (unique.length === 1) return unique[0];

  return findCommonRoot(hostPaths);
}

// =========================================================================
// COMPONENTS
// =========================================================================

function StepIndicator({ currentStep }: { currentStep: Step }) {
  const currentIndex = STEPS.findIndex((s) => s.key === currentStep);

  return (
    <div className="flex items-center justify-between py-4">
      {STEPS.map((step, index) => (
        <div key={step.key} className="flex items-center flex-1">
          <div className="flex flex-col items-center flex-1">
            <div
              className={`
                w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm
                ${
                  index < currentIndex
                    ? 'bg-green-500 text-white'
                    : index === currentIndex
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }
              `}
            >
              {index < currentIndex ? (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                index + 1
              )}
            </div>
            <span
              className={`
                text-xs mt-2 text-center whitespace-nowrap
                ${
                  index === currentIndex
                    ? 'text-blue-600 dark:text-blue-400 font-medium'
                    : 'text-gray-600 dark:text-gray-400'
                }
              `}
            >
              {step.title}
            </span>
          </div>
          {index < STEPS.length - 1 && (
            <div
              className={`
                h-1 flex-1 mx-1 rounded
                ${index < currentIndex ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'}
              `}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
      <div className="flex gap-3">
        <svg
          className="w-6 h-6 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
            clipRule="evenodd"
          />
        </svg>
        <div className="text-sm text-blue-800 dark:text-blue-200">{children}</div>
      </div>
    </div>
  );
}

function WarningBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 border border-amber-200 dark:border-amber-800">
      <div className="flex gap-3">
        <svg
          className="w-6 h-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <div className="text-sm text-amber-800 dark:text-amber-200">{children}</div>
      </div>
    </div>
  );
}

function CodeBlock({ children, label, onCopy }: { children: string; label?: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    onCopy?.();
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      )}
      <div className="bg-gray-900 dark:bg-gray-950 rounded-lg p-4 font-mono text-sm text-gray-100 overflow-x-auto">
        <pre className="whitespace-pre">{children}</pre>
      </div>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
        style={label ? { top: '1.75rem' } : undefined}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

// =========================================================================
// STEP COMPONENTS
// =========================================================================

function ClientSelectionStep({
  selectedClients,
  onToggle,
  onNext,
}: {
  selectedClients: Set<DownloadClientType>;
  onToggle: (client: DownloadClientType) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Which download clients do you use?
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Select all the download clients you have configured or plan to use with ReadMeABook.
        </p>
      </div>

      <div className="space-y-3">
        {ALL_CLIENTS.map((client) => {
          const protocol = CLIENT_PROTOCOL_MAP[client];
          const isSelected = selectedClients.has(client);

          return (
            <button
              key={client}
              onClick={() => onToggle(client)}
              className={`
                w-full flex items-center gap-4 p-4 rounded-lg border-2 transition-all text-left
                ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }
              `}
            >
              <div
                className={`
                  w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0
                  ${
                    isSelected
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-gray-300 dark:border-gray-600'
                  }
                `}
              >
                {isSelected && (
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {CLIENT_DISPLAY_NAMES[client]}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400 capitalize">
                  {protocol} client
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={onNext} disabled={selectedClients.size === 0}>
          Next
        </Button>
      </div>
    </div>
  );
}

function SavePathsStep({
  configs,
  onUpdateConfig,
  onNext,
  onBack,
}: {
  configs: ClientConfig[];
  onUpdateConfig: (type: DownloadClientType, field: keyof ClientConfig, value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const allFilled = configs.every((c) => c.savePath.trim() !== '');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Download client save paths
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          For each client, enter the path <strong>inside that client&apos;s container</strong> where
          completed downloads are saved. This is the path you see in the client&apos;s own settings
          (e.g., qBittorrent Web UI &rarr; Options &rarr; Downloads &rarr; Default Save Path).
        </p>
      </div>

      <InfoBox>
        <p>
          <strong>This is the container path, not the host path.</strong> For example, if your
          qBittorrent docker-compose has <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">-
          /mnt/data/torrents:/downloads</code>, and qBittorrent is configured to save
          to <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">/downloads</code>, then
          enter <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">/downloads</code> here.
        </p>
      </InfoBox>

      <div className="space-y-4">
        {configs.map((config) => (
          <div key={config.type} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2 mb-3">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {CLIENT_DISPLAY_NAMES[config.type]}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 capitalize">
                {CLIENT_PROTOCOL_MAP[config.type]}
              </span>
            </div>
            <Input
              placeholder={DEFAULT_SAVE_PATHS[config.type]}
              value={config.savePath}
              onChange={(e) => onUpdateConfig(config.type, 'savePath', e.target.value)}
              className="font-mono"
              helperText={`Default: ${DEFAULT_SAVE_PATHS[config.type]}`}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-between pt-4">
        <Button onClick={onBack} variant="outline">
          Back
        </Button>
        <Button onClick={onNext} disabled={!allFilled}>
          Next
        </Button>
      </div>
    </div>
  );
}

function HostPathsStep({
  configs,
  onUpdateConfig,
  onNext,
  onBack,
}: {
  configs: ClientConfig[];
  onUpdateConfig: (type: DownloadClientType, field: keyof ClientConfig, value: string | boolean) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const allFilled = configs.every(
    (c) => c.hostPath.trim() !== '' && c.containerMountPath.trim() !== '' && (!c.remotePathMapping || c.remotePath.trim() !== '')
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Docker volume mappings
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          For each client, enter the volume mapping from <strong>that client&apos;s</strong> docker-compose
          file. This tells us where on your host machine the downloads actually end up.
        </p>
      </div>

      <InfoBox>
        <p>
          A Docker volume mapping looks like <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">/host/path:/container/path</code> in
          your docker-compose.yml. We need both sides so we know how to map RMAB to the same files.
        </p>
      </InfoBox>

      <div className="space-y-6">
        {configs.map((config) => (
          <div key={config.type} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-5 border border-gray-200 dark:border-gray-700 space-y-4">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {CLIENT_DISPLAY_NAMES[config.type]}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 capitalize">
                {CLIENT_PROTOCOL_MAP[config.type]}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Host path (left side of :)"
                placeholder="/mnt/data/downloads"
                value={config.hostPath}
                onChange={(e) => onUpdateConfig(config.type, 'hostPath', e.target.value)}
                className="font-mono"
                helperText="The real path on your server"
              />
              <Input
                label="Container path (right side of :)"
                placeholder="/downloads"
                value={config.containerMountPath}
                onChange={(e) => onUpdateConfig(config.type, 'containerMountPath', e.target.value)}
                className="font-mono"
                helperText="The path inside the container"
              />
            </div>

            {config.containerMountPath && config.hostPath && (
              <div className="text-sm text-gray-600 dark:text-gray-400 font-mono bg-gray-100 dark:bg-gray-900 rounded px-3 py-2">
                {config.hostPath}:{config.containerMountPath}
              </div>
            )}

            {/* Remote path mapping toggle */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`remote-${config.type}`}
                  checked={config.remotePathMapping}
                  onChange={(e) => onUpdateConfig(config.type, 'remotePathMapping', e.target.checked)}
                  className="mt-1 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="flex-1">
                  <label
                    htmlFor={`remote-${config.type}`}
                    className="block text-sm font-medium text-gray-900 dark:text-gray-100 cursor-pointer"
                  >
                    This client runs on a different machine than RMAB
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Enable this if the download client is on a seedbox, separate server, or otherwise has a
                    different filesystem than where RMAB runs. Also enable this if the client runs on the
                    host (not in Docker) while RMAB runs in Docker.
                  </p>
                </div>
              </div>

              {config.remotePathMapping && (
                <div className="mt-3 ml-8">
                  <Input
                    label="Remote path (as seen by the download client)"
                    placeholder="/remote/mnt/downloads/complete"
                    value={config.remotePath}
                    onChange={(e) => onUpdateConfig(config.type, 'remotePath', e.target.value)}
                    className="font-mono"
                    helperText="The path the download client reports when a download completes. This is often the same as the client's save path."
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-between pt-4">
        <Button onClick={onBack} variant="outline">
          Back
        </Button>
        <Button onClick={onNext} disabled={!allFilled}>
          Generate Configuration
        </Button>
      </div>
    </div>
  );
}

function ResultsStep({
  configs,
  onBack,
  onRestart,
}: {
  configs: ClientConfig[];
  onBack: () => void;
  onRestart: () => void;
}) {
  // Determine if we need custom paths (multiple clients with different save paths)
  const savePaths = configs.map((c) => c.savePath.replace(/\/+$/, ''));
  const uniqueSavePaths = [...new Set(savePaths)];
  const needsCustomPaths = configs.length > 1 && uniqueSavePaths.length > 1;

  // Calculate RMAB download directory
  const rmabDownloadDir = needsCustomPaths ? findCommonRoot(savePaths) : savePaths[0];

  // Calculate custom paths per client (only if needed)
  const clientCustomPaths = needsCustomPaths
    ? configs.map((c) => ({
        type: c.type,
        customPath: getRelativePath(rmabDownloadDir, c.savePath.replace(/\/+$/, '')),
      }))
    : [];

  // Calculate RMAB volume mapping
  // We need the host path that corresponds to the rmabDownloadDir
  // If all clients share the same save path, we use that client's host path directly.
  // If multiple different paths, we find the common host root.
  let rmabHostPath: string;
  let rmabContainerPath: string;

  if (!needsCustomPaths) {
    // Single path scenario — use the first client's host path
    // But we need to consider if the container mount path differs from the save path
    const config = configs[0];
    const saveRelativeToMount = getRelativePath(
      config.containerMountPath.replace(/\/+$/, ''),
      config.savePath.replace(/\/+$/, '')
    );

    if (saveRelativeToMount) {
      // Save path is deeper than the mount: host must include that extra depth
      rmabHostPath = config.hostPath.replace(/\/+$/, '') + '/' + saveRelativeToMount;
    } else {
      rmabHostPath = config.hostPath;
    }
    rmabContainerPath = rmabDownloadDir;
  } else {
    // Multiple different paths — we need to find the host root that covers all
    // For each client, compute the host path that corresponds to the common container root
    const hostRoots = configs.map((c) => {
      const mountRelativeToCommon = getRelativePath(
        rmabDownloadDir,
        c.containerMountPath.replace(/\/+$/, '')
      );
      const saveRelativeToMount = getRelativePath(
        c.containerMountPath.replace(/\/+$/, ''),
        c.savePath.replace(/\/+$/, '')
      );
      // The host path maps to containerMountPath. We need to go up if rmabDownloadDir
      // is a parent of the container mount path.
      const containerMountNorm = c.containerMountPath.replace(/\/+$/, '');
      const rmabDirNorm = rmabDownloadDir.replace(/\/+$/, '');

      if (containerMountNorm === rmabDirNorm) {
        return c.hostPath.replace(/\/+$/, '');
      } else if (containerMountNorm.startsWith(rmabDirNorm + '/')) {
        // Container mount is deeper than RMAB dir — we need to go up on the host side
        const depth = containerMountNorm.slice(rmabDirNorm.length + 1).split('/').length;
        const hostSegments = c.hostPath.replace(/\/+$/, '').split('/');
        return hostSegments.slice(0, -depth).join('/') || '/';
      } else if (rmabDirNorm.startsWith(containerMountNorm + '/')) {
        // RMAB dir is deeper than container mount — append the extra to host
        const extra = rmabDirNorm.slice(containerMountNorm.length + 1);
        return c.hostPath.replace(/\/+$/, '') + '/' + extra;
      }
      return c.hostPath.replace(/\/+$/, '');
    });

    rmabHostPath = findHostCommonRoot(
      configs.map((c, i) => ({ ...c, hostPath: hostRoots[i] }))
    );
    rmabContainerPath = rmabDownloadDir;
  }

  // Build the RMAB compose snippet
  const composeSnippet = `services:
  readmeabook:
    volumes:
      - ${rmabHostPath}:${rmabContainerPath}
      # ... your other RMAB volumes (config, media, etc.)`;

  // Build remote path mapping info
  const remoteClients = configs.filter((c) => c.remotePathMapping);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Your recommended configuration
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Based on your inputs, here&apos;s how to configure ReadMeABook and your download clients.
        </p>
      </div>

      {/* RMAB Download Directory */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          1. RMAB Download Directory Setting
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Set this in RMAB&apos;s settings under <strong>Admin &rarr; Settings &rarr; Paths &rarr; Download Directory</strong>.
        </p>
        <CodeBlock label="Download Directory">{rmabDownloadDir}</CodeBlock>
      </div>

      {/* Custom paths per client */}
      {needsCustomPaths && clientCustomPaths.some((c) => c.customPath) && (
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            2. Client Custom Paths
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Since your clients save to different locations, set these custom paths on each download client
            in RMAB (<strong>Admin &rarr; Settings &rarr; Download Clients &rarr; Edit &rarr; Custom Path</strong>).
          </p>
          <div className="space-y-2">
            {clientCustomPaths.map((c) => (
              <div key={c.type} className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                <span className="font-medium text-gray-900 dark:text-gray-100 min-w-[120px]">
                  {CLIENT_DISPLAY_NAMES[c.type as DownloadClientType]}:
                </span>
                <code className="font-mono text-sm bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded text-gray-800 dark:text-gray-200">
                  {c.customPath || '(none — same as download directory)'}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RMAB Docker Compose Volume */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {needsCustomPaths ? '3' : '2'}. RMAB Docker Compose Volume Mapping
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Add this volume mapping to your RMAB docker-compose.yml. This ensures RMAB can see the
          same files your download clients produce.
        </p>
        <CodeBlock label="docker-compose.yml">{composeSnippet}</CodeBlock>
      </div>

      {/* Golden Rule explanation */}
      <WarningBox>
        <p className="font-semibold mb-1">The Golden Rule</p>
        <p>
          Both your download client and RMAB must see files at the <strong>same container path</strong>.
          The volume mapping above ensures that when your download client saves a file
          to <code className="bg-amber-100 dark:bg-amber-800 px-1 rounded">{configs[0]?.savePath}</code>,
          RMAB can also find it at that same path.
        </p>
      </WarningBox>

      {/* Verification */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {needsCustomPaths ? '4' : '3'}. Verify your setup
        </h3>
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            {configs.map((c) => (
              <li key={c.type} className="flex items-start gap-2">
                <span className="text-gray-400 mt-0.5">&#8226;</span>
                <span>
                  <strong>{CLIENT_DISPLAY_NAMES[c.type]}</strong> saves
                  to <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded font-mono text-xs">{c.savePath}</code>
                  {' '}&rarr; host path <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded font-mono text-xs">{c.hostPath}</code>
                  {needsCustomPaths && (
                    <>
                      {' '}&rarr; RMAB custom
                      path: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded font-mono text-xs">
                        {getRelativePath(rmabDownloadDir, c.savePath.replace(/\/+$/, '')) || '(none)'}
                      </code>
                    </>
                  )}
                </span>
              </li>
            ))}
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">&#8226;</span>
              <span>
                <strong>RMAB</strong> mounts <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded font-mono text-xs">{rmabHostPath}:{rmabContainerPath}</code>
                {' '}&rarr; download directory set
                to <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded font-mono text-xs">{rmabDownloadDir}</code>
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Remote Path Mapping */}
      {remoteClients.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Remote Path Mapping
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            These clients run on a different machine. Configure remote path mapping for each in
            RMAB (<strong>Admin &rarr; Settings &rarr; Download Clients &rarr; Edit</strong>).
          </p>
          <div className="space-y-3">
            {remoteClients.map((c) => {
              const localPath = needsCustomPaths
                ? rmabDownloadDir + '/' + getRelativePath(rmabDownloadDir, c.savePath.replace(/\/+$/, ''))
                : rmabDownloadDir;

              return (
                <div key={c.type} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700 space-y-2">
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {CLIENT_DISPLAY_NAMES[c.type]}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block mb-1">Enable Remote Path Mapping:</span>
                      <code className="bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded font-mono text-gray-800 dark:text-gray-200">Yes</code>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block mb-1">Remote Path:</span>
                      <code className="bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded font-mono text-gray-800 dark:text-gray-200">{c.remotePath}</code>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-gray-500 dark:text-gray-400 block mb-1">Local Path:</span>
                      <code className="bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded font-mono text-gray-800 dark:text-gray-200">{localPath}</code>
                    </div>
                  </div>
                  <InfoBox>
                    <p>
                      When this client reports a file at <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{c.remotePath}/audiobook.m4b</code>,
                      RMAB will translate it to <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{localPath}/audiobook.m4b</code>.
                    </p>
                  </InfoBox>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button onClick={onBack} variant="outline">
          Back
        </Button>
        <Button onClick={onRestart} variant="secondary">
          Start Over
        </Button>
      </div>
    </div>
  );
}

// =========================================================================
// MAIN PAGE
// =========================================================================

export default function PathHelperPage() {
  const [step, setStep] = useState<Step>('clients');
  const [selectedClients, setSelectedClients] = useState<Set<DownloadClientType>>(new Set());
  const [clientConfigs, setClientConfigs] = useState<Map<DownloadClientType, ClientConfig>>(new Map());

  // Build ordered configs array from selected clients
  const configs = useMemo(() => {
    return ALL_CLIENTS
      .filter((c) => selectedClients.has(c))
      .map((type) => {
        const existing = clientConfigs.get(type);
        return (
          existing || {
            type,
            savePath: DEFAULT_SAVE_PATHS[type],
            hostPath: '',
            containerMountPath: '',
            remotePathMapping: false,
            remotePath: '',
          }
        );
      });
  }, [selectedClients, clientConfigs]);

  const toggleClient = (client: DownloadClientType) => {
    setSelectedClients((prev) => {
      const next = new Set(prev);
      if (next.has(client)) {
        next.delete(client);
      } else {
        next.add(client);
        // Initialize config if not exists
        if (!clientConfigs.has(client)) {
          setClientConfigs((prev) => {
            const next = new Map(prev);
            next.set(client, {
              type: client,
              savePath: DEFAULT_SAVE_PATHS[client],
              hostPath: '',
              containerMountPath: '',
              remotePathMapping: false,
              remotePath: '',
            });
            return next;
          });
        }
      }
      return next;
    });
  };

  const updateConfig = (type: DownloadClientType, field: keyof ClientConfig, value: string | boolean) => {
    setClientConfigs((prev) => {
      const next = new Map(prev);
      const existing = next.get(type);
      if (existing) {
        next.set(type, { ...existing, [field]: value });
      }
      return next;
    });
  };

  const goToStep = (target: Step) => setStep(target);

  const restart = () => {
    setStep('clients');
    setSelectedClients(new Set());
    setClientConfigs(new Map());
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Path Mapping Helper
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Get your download client volume mappings configured correctly for ReadMeABook
          </p>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="container mx-auto px-2 sm:px-4 max-w-4xl">
          <StepIndicator currentStep={step} />
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-8">
          {step === 'clients' && (
            <ClientSelectionStep
              selectedClients={selectedClients}
              onToggle={toggleClient}
              onNext={() => goToStep('save-paths')}
            />
          )}
          {step === 'save-paths' && (
            <SavePathsStep
              configs={configs}
              onUpdateConfig={updateConfig}
              onNext={() => goToStep('host-paths')}
              onBack={() => goToStep('clients')}
            />
          )}
          {step === 'host-paths' && (
            <HostPathsStep
              configs={configs}
              onUpdateConfig={updateConfig}
              onNext={() => goToStep('results')}
              onBack={() => goToStep('save-paths')}
            />
          )}
          {step === 'results' && (
            <ResultsStep
              configs={configs}
              onBack={() => goToStep('host-paths')}
              onRestart={restart}
            />
          )}
        </div>
      </div>
    </div>
  );
}
