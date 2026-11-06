import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { UpdateState } from '@foliux-pdf/core';
import { UpdateManager, describeUpdateError, type UpdaterLike } from '@foliux-pdf/services/node';

/** Actualizador falso: guarda lo que se le pide y deja emitir eventos a mano. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  downloads = 0;
  installs: unknown[][] = [];
  checkImpl: () => Promise<unknown> = async () => {
    this.emit('checking-for-update');
    this.emit('update-available', {
      version: '1.2.0',
      releaseNotes: '<p>Mejoras</p><ul><li>Rápido</li></ul>',
    });
  };
  downloadImpl: () => Promise<unknown> = async () => {
    this.emit('download-progress', { percent: 42.4 });
    this.emit('update-downloaded', { version: '1.2.0' });
  };
  async checkForUpdates() {
    this.checks++;
    return this.checkImpl();
  }
  async downloadUpdate() {
    this.downloads++;
    return this.downloadImpl();
  }
  quitAndInstall(...args: unknown[]) {
    this.installs.push(args);
  }
}

function setup() {
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const manager = new UpdateManager(updater, (s) => states.push(s));
  return { updater, states, manager };
}

describe('UpdateManager', () => {
  it('desactiva la descarga y la instalación automáticas', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('en desarrollo (sin actualizador) no está disponible y no hace nada', async () => {
    const states: UpdateState[] = [];
    const manager = new UpdateManager(null, (s) => states.push(s));
    expect(manager.state.state).toBe('unavailable');
    await manager.check();
    await manager.download();
    manager.install();
    expect(states).toEqual([]);
  });

  it('buscar solo avisa: encuentra la versión pero no descarga nada', async () => {
    const { updater, manager } = setup();
    await manager.check();
    expect(manager.state).toMatchObject({ state: 'available', version: '1.2.0' });
    expect(updater.downloads).toBe(0);
    // Las notas llegan como texto plano
    const s = manager.state;
    expect(s.state === 'available' && s.notes).toContain('Mejoras');
    expect(s.state === 'available' && s.notes).not.toContain('<');
  });

  it('descarga con progreso y deja la versión lista; instalar pide reinicio', async () => {
    const { updater, states, manager } = setup();
    await manager.check();
    await manager.download();
    expect(states.some((s) => s.state === 'downloading' && s.percent === 42)).toBe(true);
    expect(manager.state).toEqual({ state: 'downloaded', version: '1.2.0' });
    manager.install();
    expect(updater.installs).toEqual([[false, true]]);
  });

  it('no descarga ni instala si antes no corresponde', async () => {
    const { updater, manager } = setup();
    await manager.download(); // sin haber buscado
    manager.install(); // sin haber descargado
    expect(updater.downloads).toBe(0);
    expect(updater.installs).toEqual([]);
  });

  it('«al día» cuando no hay versión nueva', async () => {
    const { updater, manager } = setup();
    updater.checkImpl = async () => {
      updater.emit('checking-for-update');
      updater.emit('update-not-available', {});
    };
    await manager.check();
    expect(manager.state.state).toBe('none');
  });

  it('un fallo de red se traduce a un mensaje claro y permite reintentar', async () => {
    const { updater, manager } = setup();
    updater.checkImpl = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    await manager.check();
    expect(manager.state).toMatchObject({ state: 'error' });
    expect(manager.state.state === 'error' && manager.state.message).toContain('conexión');
    updater.checkImpl = async () => updater.emit('update-not-available', {});
    await manager.check();
    expect(manager.state.state).toBe('none');
    expect(updater.checks).toBe(2);
  });

  it('un fallo al descargar queda como error, no como descargada', async () => {
    const { updater, manager } = setup();
    await manager.check();
    updater.downloadImpl = async () => {
      throw new Error('sha512 checksum mismatch');
    };
    await manager.download();
    expect(manager.state.state).toBe('error');
    expect(manager.state.state === 'error' && manager.state.message).toContain('integridad');
    manager.install();
    expect(updater.installs).toEqual([]);
  });

  it('no busca de nuevo mientras descarga', async () => {
    const { updater, manager } = setup();
    await manager.check();
    updater.downloadImpl = () => new Promise(() => undefined); // se queda descargando
    void manager.download();
    await Promise.resolve();
    await manager.check();
    expect(updater.checks).toBe(1);
  });
});

describe('describeUpdateError', () => {
  it('no filtra el detalle técnico al usuario', () => {
    expect(describeUpdateError(new Error('Cannot find latest.yml (404)'))).toContain(
      'Todavía no hay una versión publicada',
    );
    expect(describeUpdateError(new Error('algo raro con C:\\ruta\\secreta'))).not.toContain(
      'secreta',
    );
  });
});
