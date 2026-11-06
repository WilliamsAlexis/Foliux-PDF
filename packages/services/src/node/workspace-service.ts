import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  FoliuxError,
  MAX_WORKSPACE_DOCUMENTS,
  WorkspaceFileSchema,
  validateWorkspaceName,
  type ILogger,
  type Workspace,
  type WorkspaceFile,
  type WorkspaceView,
} from '@foliux-pdf/core';
import { JsonFileStore } from './json-file-store';

/** Espacios de trabajo guardados en un JSON. Solo guardan rutas: no tocan los PDF. */
export class WorkspaceService {
  private readonly store: JsonFileStore<WorkspaceFile>;
  /** Las operaciones se encadenan para que dos cambios seguidos no se pisen al escribir. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storePath: string, logger?: ILogger) {
    this.store = new JsonFileStore(
      storePath,
      WorkspaceFileSchema,
      () => ({ workspaces: [] }),
      logger,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async view(workspace: Workspace): Promise<WorkspaceView> {
    const documents = await Promise.all(
      workspace.documents.map(async (doc) => ({
        ...doc,
        exists: await access(doc.path).then(
          () => true,
          () => false,
        ),
      })),
    );
    return { ...workspace, documents };
  }

  /** Aplica un cambio a un espacio y lo guarda. */
  private async change(
    id: string,
    apply: (workspace: Workspace) => Workspace,
  ): Promise<WorkspaceView> {
    return this.serial(async () => {
      const file = await this.store.read();
      const found = file.workspaces.find((w) => w.id === id);
      if (!found) throw new FoliuxError('INVALID_REQUEST', 'El espacio de trabajo ya no existe.');
      const updated = apply(found);
      await this.store.write({
        workspaces: file.workspaces.map((w) => (w.id === id ? updated : w)),
      });
      return this.view(updated);
    });
  }

  async list(): Promise<WorkspaceView[]> {
    const file = await this.serial(() => this.store.read());
    return Promise.all(file.workspaces.map((w) => this.view(w)));
  }

  async create(name: string): Promise<WorkspaceView> {
    const problem = validateWorkspaceName(name);
    if (problem) throw new FoliuxError('INVALID_REQUEST', problem);
    return this.serial(async () => {
      const file = await this.store.read();
      if (file.workspaces.length >= 100) {
        throw new FoliuxError('INVALID_REQUEST', 'Has llegado al máximo de espacios de trabajo.');
      }
      const workspace: Workspace = {
        id: randomUUID(),
        name: name.trim(),
        createdAt: Date.now(),
        documents: [],
      };
      await this.store.write({ workspaces: [...file.workspaces, workspace] });
      return this.view(workspace);
    });
  }

  rename(id: string, name: string): Promise<WorkspaceView> {
    const problem = validateWorkspaceName(name);
    if (problem) return Promise.reject(new FoliuxError('INVALID_REQUEST', problem));
    return this.change(id, (w) => ({ ...w, name: name.trim() }));
  }

  async delete(id: string): Promise<void> {
    await this.serial(async () => {
      const file = await this.store.read();
      await this.store.write({ workspaces: file.workspaces.filter((w) => w.id !== id) });
    });
  }

  /** Añade documentos (sin repetir; se compara sin distinguir mayúsculas, como hace Windows). */
  addDocuments(id: string, paths: readonly string[]): Promise<WorkspaceView> {
    return this.change(id, (workspace) => {
      const known = new Set(workspace.documents.map((d) => d.path.toLowerCase()));
      const documents = [...workspace.documents];
      for (const path of paths) {
        if (known.has(path.toLowerCase())) continue;
        known.add(path.toLowerCase());
        documents.push({ path, name: basename(path) });
      }
      if (documents.length > MAX_WORKSPACE_DOCUMENTS) {
        throw new FoliuxError(
          'INVALID_REQUEST',
          `Un espacio admite como máximo ${MAX_WORKSPACE_DOCUMENTS} documentos.`,
        );
      }
      return { ...workspace, documents };
    });
  }

  removeDocument(id: string, path: string): Promise<WorkspaceView> {
    return this.change(id, (workspace) => ({
      ...workspace,
      documents: workspace.documents.filter((d) => d.path.toLowerCase() !== path.toLowerCase()),
    }));
  }
}
