---
title: Download
---

<script setup>
import { ref, computed, onMounted } from 'vue'

const RELEASES = 'https://github.com/loumalouomega/KKSS/releases'
const rel = ref(null)
const failed = ref(false)

// Rows keyed by the "-<os>-<arch>." substring electron-builder.yml's
// artifactName pattern guarantees (KKSS-<version>-<os>-<arch>.<ext>).
const targets = [
  { label: 'Linux', arch: 'x86-64', key: '-linux-x64.', note: 'AppImage (portable) or .deb' },
  { label: 'Linux', arch: 'ARM 64', key: '-linux-arm64.', note: 'AppImage (portable) or .deb' },
  { label: 'Windows', arch: 'x86-64', key: '-win-x64.', note: 'NSIS installer' },
  { label: 'Windows', arch: 'ARM 64', key: '-win-arm64.', note: 'NSIS installer' },
  { label: 'macOS', arch: 'Apple Silicon (ARM 64)', key: '-mac-arm64.', note: '.dmg (or .zip)' },
]

const rows = computed(() =>
  targets.map((t) => ({
    ...t,
    assets: (rel.value?.assets ?? []).filter(
      (a) => a.name.includes(t.key) && !a.name.endsWith('.blockmap')
    ),
  }))
)

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/loumalouomega/KKSS/releases/latest')
    if (!res.ok) throw new Error(String(res.status))
    rel.value = await res.json()
  } catch {
    failed.value = true
  }
})
</script>

# Download KKSS

KKSS is built for every release tag by the [release workflow](https://github.com/loumalouomega/KKSS/blob/master/.github/workflows/release.yml) and published to [GitHub Releases](https://github.com/loumalouomega/KKSS/releases).

<p v-if="rel">
Latest release: <a :href="rel.html_url"><strong>{{ rel.tag_name }}</strong></a>
  <span v-if="rel.published_at"> · {{ new Date(rel.published_at).toLocaleDateString() }}</span>
</p>
<p v-else-if="failed">
Could not query the GitHub API from your browser — grab the installers directly from the
  <a :href="RELEASES + '/latest'"><strong>latest release page</strong></a>.
</p>
<p v-else>Loading the latest release…</p>

<table>
  <thead>
    <tr><th>Platform</th><th>Architecture</th><th>Files</th></tr>
  </thead>
  <tbody>
    <tr v-for="t in rows" :key="t.key">
      <td>{{ t.label }}</td>
      <td>{{ t.arch }}</td>
      <td>
        <template v-if="t.assets.length">
          <div v-for="a in t.assets" :key="a.name">
            <a :href="a.browser_download_url">{{ a.name }}</a> ({{ mb(a.size) }})
          </div>
        </template>
        <template v-else>
{{ t.note }} — see the <a :href="RELEASES + '/latest'">release page</a>
        </template>
      </td>
    </tr>
  </tbody>
</table>

::: tip Which file do I want?
- **Linux**: the `.AppImage` runs anywhere without installation (`chmod +x` it); the `.deb` integrates with apt-based distributions.
- **Windows**: the `.exe` is a standard NSIS installer (choose your install directory during setup).
- **macOS**: open the `.dmg` and drag KKSS to Applications. Release builds are currently **unsigned** — right-click the app and choose *Open* the first time to bypass Gatekeeper.
:::

Older versions and release notes live on the [releases page](https://github.com/loumalouomega/KKSS/releases).
