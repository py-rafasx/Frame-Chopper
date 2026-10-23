// Startup gate: explains how to install FFmpeg when it is not available.
(function initFfmpegGate() {
    const gate = document.getElementById('ffmpeg-gate');
    if (!gate || typeof window.api?.checkFfmpeg !== 'function') {
        return;
    }

    const elements = {
        command: document.getElementById('ffmpeg-gate-command'),
        copy: document.getElementById('ffmpeg-gate-copy'),
        details: document.getElementById('ffmpeg-gate-details'),
        alternatives: document.getElementById('ffmpeg-gate-alternatives'),
        status: document.getElementById('ffmpeg-gate-status'),
        retry: document.getElementById('ffmpeg-gate-retry'),
        download: document.getElementById('ffmpeg-gate-download'),
        downloadLabel: document.getElementById('ffmpeg-gate-download-label')
    };

    const tabs = Array.from(document.querySelectorAll('.ffmpeg-gate__os-tab'));

    const PLATFORMS = {
        windows: {
            name: 'Windows',
            commands: [
                { label: 'winget', command: 'winget install --id Gyan.FFmpeg.Essentials -e' },
                { label: 'Chocolatey', command: 'choco install ffmpeg -y' },
                { label: 'Scoop', command: 'scoop install ffmpeg' }
            ],
            download: {
                label: 'Download for Windows',
                url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
            }
        },
        macos: {
            name: 'macOS',
            commands: [
                { label: 'Homebrew', command: 'brew install ffmpeg' }
            ],
            download: {
                label: 'Download for macOS',
                url: 'https://ffmpeg.org/download.html#build-mac'
            }
        },
        linux: {
            name: 'Linux',
            commands: [
                { label: 'Debian / Ubuntu', command: 'sudo apt install ffmpeg' },
                { label: 'Fedora', command: 'sudo dnf install ffmpeg' },
                { label: 'Arch', command: 'sudo pacman -S ffmpeg' }
            ],
            download: {
                label: 'Download for Linux',
                url: 'https://www.johnvansickle.com/ffmpeg/'
            }
        }
    };

    const COPY_ICON =
        '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/>' +
        '<path d="M10.25 5.75V4.5A1.5 1.5 0 0 0 8.75 3H4.5A1.5 1.5 0 0 0 3 4.5v4.25a1.5 1.5 0 0 0 1.5 1.5h1.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '</svg>';

    const background = Array.from(document.querySelectorAll('.app > *')).filter(
        (element) => element !== gate && !element.classList.contains('title-bar')
    );

    let detectedPlatform = detectPlatform();
    let platform = detectedPlatform;
    let userSelectedPlatform = false;
    let currentCommand = '';
    let checking = false;

    function detectPlatform(statusPlatform) {
        const value = String(statusPlatform || '').toLowerCase();
        if (value.includes('win')) {
            return 'windows';
        }
        if (value.includes('mac') || value.includes('darwin')) {
            return 'macos';
        }
        if (value.includes('linux')) {
            return 'linux';
        }

        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes('windows')) {
            return 'windows';
        }
        if (userAgent.includes('mac')) {
            return 'macos';
        }
        return 'linux';
    }

    function setBackgroundInert(inert) {
        background.forEach((element) => {
            element.inert = inert;
        });
    }

    function setStatus(message, kind) {
        elements.status.textContent = message || '';
        elements.status.classList.remove(
            'ffmpeg-gate__status--error',
            'ffmpeg-gate__status--success'
        );
        if (kind) {
            elements.status.classList.add(`ffmpeg-gate__status--${kind}`);
        }
    }

    function setCopyLabel(button, text) {
        const label = button.querySelector('[data-copy-label]');
        if (label) {
            label.textContent = text;
        } else {
            button.setAttribute('aria-label', text);
        }
    }

    async function copyText(text, button) {
        const label = button.querySelector('[data-copy-label]');
        const original = label ? label.textContent : button.getAttribute('aria-label') || 'Copy';
        let copied = false;

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                copied = true;
            }
        } catch {
            copied = false;
        }

        if (!copied) {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                document.body.appendChild(textarea);
                textarea.select();
                copied = document.execCommand('copy');
                textarea.remove();
            } catch {
                copied = false;
            }
        }

        setCopyLabel(button, copied ? 'Copied' : 'Failed');
        window.setTimeout(() => {
            setCopyLabel(button, original);
        }, 1500);
    }

    function createCopyButton(command, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ffmpeg-gate__copy';
        button.setAttribute('aria-label', `Copy ${label} command`);
        button.innerHTML = `${COPY_ICON}<span data-copy-label>Copy</span>`;
        button.addEventListener('click', () => copyText(command, button));
        return button;
    }

    function renderPlatform() {
        const data = PLATFORMS[platform] || PLATFORMS.linux;
        const [primary, ...alternatives] = data.commands;

        currentCommand = primary.command;
        elements.command.textContent = primary.command;
        elements.downloadLabel.textContent = data.download.label;
        elements.download.dataset.url = data.download.url;

        elements.alternatives.innerHTML = '';
        alternatives.forEach(({ label, command }) => {
            const row = document.createElement('div');
            row.className = 'ffmpeg-gate__alternative';

            const info = document.createElement('div');
            info.className = 'ffmpeg-gate__alternative-info';

            const name = document.createElement('span');
            name.className = 'ffmpeg-gate__alternative-label';
            name.textContent = label;

            const code = document.createElement('code');
            code.textContent = command;

            info.append(name, code);
            row.append(info, createCopyButton(command, label));
            elements.alternatives.appendChild(row);
        });

        elements.details.hidden = alternatives.length === 0;
        updateTabs();
    }

    function updateTabs() {
        tabs.forEach((tab) => {
            const id = tab.dataset.platform;
            const name = PLATFORMS[id]?.name || id;
            const detected = id === detectedPlatform;

            tab.setAttribute('aria-pressed', String(id === platform));
            tab.dataset.detected = String(detected);
            tab.setAttribute(
                'aria-label',
                detected ? `${name} (detected on this system)` : name
            );
        });
    }

    function showGate(status) {
        if (status?.platform) {
            detectedPlatform = detectPlatform(status.platform);
            if (!userSelectedPlatform) {
                platform = detectedPlatform;
            }
        }

        renderPlatform();

        if (status?.ffmpegPath && !status?.ffprobePath) {
            setStatus('FFmpeg was found, but ffprobe is missing.', 'error');
        } else if (status?.ffmpegPath && status?.ffprobePath && !status?.available) {
            setStatus('FFmpeg was found, but it could not be executed.', 'error');
        } else {
            setStatus('');
        }

        setBackgroundInert(true);
        gate.hidden = false;
        elements.retry.focus();
    }

    function hideGate() {
        gate.hidden = true;
        setBackgroundInert(false);
    }

    async function check(isRetry) {
        if (checking) {
            return;
        }

        checking = true;
        elements.retry.disabled = true;
        const originalText = elements.retry.textContent;
        elements.retry.textContent = 'Checking...';

        try {
            const status = await window.api.checkFfmpeg();
            if (status?.available) {
                hideGate();
                setStatus('');
                return;
            }

            showGate(status);
            if (isRetry) {
                if (status?.ffmpegPath && !status?.ffprobePath) {
                    setStatus(
                        'ffprobe is still missing. Install the full FFmpeg package and try again.',
                        'error'
                    );
                } else if (status?.ffmpegPath && status?.ffprobePath) {
                    setStatus(
                        'FFmpeg is still not working. Restart the app or reinstall FFmpeg.',
                        'error'
                    );
                } else {
                    setStatus('Still not found. Install FFmpeg and try again.', 'error');
                }
            }
        } catch (error) {
            showGate(null);
            setStatus(
                error?.message
                    ? `Could not verify FFmpeg: ${error.message}`
                    : 'Could not verify FFmpeg. Try again.',
                'error'
            );
        } finally {
            checking = false;
            elements.retry.disabled = false;
            elements.retry.textContent = originalText;
        }
    }

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const id = tab.dataset.platform;
            if (!PLATFORMS[id] || id === platform) {
                return;
            }

            platform = id;
            userSelectedPlatform = true;
            setStatus('');
            renderPlatform();
        });
    });

    elements.copy.addEventListener('click', () => copyText(currentCommand, elements.copy));
    elements.retry.addEventListener('click', () => check(true));
    elements.download.addEventListener('click', () => {
        const url = elements.download.dataset.url;
        if (!url) {
            return;
        }

        if (typeof window.api?.openUrl === 'function') {
            window.api.openUrl(url).catch(() => {});
        } else {
            window.open(url, '_blank', 'noopener');
        }
    });

    renderPlatform();
    check(false);
})();
