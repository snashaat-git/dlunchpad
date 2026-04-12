const express = require('express');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const GROUPS_FILE = '/app/data/groups.json';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Groups persistence helpers ───────────────────────────────────────────────

async function readGroups() {
  try {
    const raw = await fs.readFile(GROUPS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeGroups(groups) {
  await fs.mkdir(path.dirname(GROUPS_FILE), { recursive: true });
  await fs.writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

// ── Container routes ─────────────────────────────────────────────────────────

app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const result = containers.map(c => {
      const ports = (c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => ({ hostPort: p.PublicPort, containerPort: p.PrivatePort }));
      return {
        id: c.Id.slice(0, 12),
        name: (c.Names[0] || '').replace(/^\//, ''),
        status: c.Status,
        state: c.State,
        image: c.Image,
        ports,
      };
    });
    result.sort((a, b) => {
      if (a.state === b.state) return a.name.localeCompare(b.name);
      return a.state === 'running' ? -1 : 1;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/start', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 304) return res.json({ ok: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/stop', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).stop();
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 304) return res.json({ ok: true });
    res.status(500).json({ error: err.message });
  }
});

// ── Groups routes ────────────────────────────────────────────────────────────

app.get('/api/groups', async (req, res) => {
  try {
    res.json(await readGroups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    const { name, containerIds } = req.body;
    if (!name || !Array.isArray(containerIds) || containerIds.length === 0)
      return res.status(400).json({ error: 'name and containerIds required' });
    const groups = await readGroups();
    const group = { id: crypto.randomUUID(), name, containerIds };
    groups.push(group);
    await writeGroups(groups);
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:id', async (req, res) => {
  try {
    const { name, containerIds } = req.body;
    const groups = await readGroups();
    const idx = groups.findIndex(g => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Group not found' });
    if (name) groups[idx].name = name;
    if (Array.isArray(containerIds)) groups[idx].containerIds = containerIds;
    await writeGroups(groups);
    res.json(groups[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  try {
    const groups = await readGroups();
    const filtered = groups.filter(g => g.id !== req.params.id);
    await writeGroups(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:id/start', async (req, res) => {
  try {
    const groups = await readGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const results = await Promise.allSettled(
      group.containerIds.map(id =>
        docker.getContainer(id).start().catch(err => {
          if (err.statusCode === 304) return; // already running
          throw err;
        })
      )
    );
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message);
    res.json({ ok: true, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:id/stop', async (req, res) => {
  try {
    const groups = await readGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const results = await Promise.allSettled(
      group.containerIds.map(id =>
        docker.getContainer(id).stop().catch(err => {
          if (err.statusCode === 304) return; // already stopped
          throw err;
        })
      )
    );
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message);
    res.json({ ok: true, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Launchpad running on :${PORT}`));
