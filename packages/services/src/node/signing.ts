import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';
import * as signpdfModule from '@signpdf/signpdf';
import * as p12Module from '@signpdf/signer-p12';
import * as placeholderModule from '@signpdf/placeholder-pdf-lib';
import { FoliuxError, type NewCertificate, type SignatureReport } from '@foliux-pdf/core';
import { loadPdf } from '../pdf-edit/page-ops';

/**
 * Firma digital de PDFs (PKCS#7 / CMS, con @signpdf y node-forge) y su verificación.
 *
 * Limitaciones: la firma no lleva sello de tiempo de una autoridad (la fecha es la del equipo), no se
 * comprueba la cadena de confianza del certificado contra las autoridades del sistema, y no se
 * comprueba su revocación. Un certificado autofirmado funciona, pero los lectores lo marcarán como no fiable.
 */

// Los paquetes de @signpdf son CommonJS: según el cargador (Node, Vite, el empaquetado de la app) lo exportado
// llega con su nombre, dentro de `default` o como el propio `default`. Se busca en los tres sitios.
function candidates(module: unknown): Record<string, unknown>[] {
  const m = module as Record<string, unknown>;
  const d = m['default'] as Record<string, unknown> | undefined;
  const dd = d?.['default'] as Record<string, unknown> | undefined;
  return [m, d, dd].filter((c): c is Record<string, unknown> => c !== undefined && c !== null);
}
const named = <T>(module: unknown, name: string): T => {
  const found = candidates(module).find((c) => c[name] !== undefined);
  if (!found) throw new Error(`No se encontró «${name}» en el módulo de firma.`);
  return found[name] as T;
};
/** El objeto (instancia) que tiene un método con ese nombre. */
const objectWith = <T>(module: unknown, method: string): T => {
  const found = candidates(module).find((c) => typeof c[method] === 'function');
  if (!found) throw new Error(`No se encontró «${method}» en el módulo de firma.`);
  return found as T;
};

const signpdf = objectWith<{
  sign: (pdf: Buffer, signer: unknown, time?: Date) => Promise<Buffer>;
}>(signpdfModule, 'sign');
const signer12 = named<new (p12: Buffer, options: { passphrase: string }) => unknown>(
  p12Module,
  'P12Signer',
);
const addPlaceholder = named<(input: Record<string, unknown>) => void>(
  placeholderModule,
  'pdflibAddPlaceholder',
);

export interface SignOptions {
  /** Certificado PKCS#12 (.p12 / .pfx). */
  certificate: Uint8Array;
  passphrase: string;
  reason: string;
  location: string;
  contact: string;
  /** Nombre del firmante que se anota en la firma. */
  name?: string;
  signingTime?: Date;
}

/** Firma el documento. El PDF debe ser el definitivo: cualquier cambio posterior invalida la firma. */
export async function signPdf(data: Uint8Array, options: SignOptions): Promise<Uint8Array> {
  const signingTime = options.signingTime ?? new Date();
  const doc = await loadPdf(data);
  addPlaceholder({
    pdfDoc: doc,
    reason: options.reason || 'Firma del documento',
    contactInfo: options.contact,
    name: options.name ?? '',
    location: options.location,
    signingTime,
    signatureLength: 16384,
  });
  // Sin flujos de objetos: @signpdf necesita una tabla de referencias clásica.
  const withPlaceholder = await doc.save({ useObjectStreams: false });

  try {
    const signer = new signer12(Buffer.from(options.certificate), {
      passphrase: options.passphrase,
    });
    const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer, signingTime);
    return new Uint8Array(signed);
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (/password|mac could not be verified|pkcs#12/i.test(message)) {
      throw new FoliuxError('PASSWORD_INVALID', 'La contraseña del certificado no es correcta.', {
        cause: error,
      });
    }
    throw new FoliuxError(
      'IO_ERROR',
      'No se pudo firmar el documento. ¿Es un certificado válido?',
      {
        cause: error,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------

const OID = {
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
};
const HASHES: Record<string, 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
  [OID.sha1]: 'sha1',
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};

const toBinary = (data: Uint8Array) => Buffer.from(data).toString('binary');

function cn(attributes: { getField(name: string): { value: string } | null }): string {
  return attributes.getField('CN')?.value ?? attributes.getField('O')?.value ?? '';
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex();
}

/** Texto de un campo entre paréntesis del diccionario de la firma (/Reason, /Location...). */
function dictString(window: string, key: string): string {
  const match = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(window);
  return match?.[1]?.replace(/\\(.)/g, '$1') ?? '';
}

const stripLeadingZeros = (hex: string) => hex.toLowerCase().replace(/^0+/, '');

interface ParsedSigner {
  authenticated: forge.asn1.Asn1[];
  digestOid: string;
  serialHex: string;
  signature: string;
}

/** Extrae del PKCS#7 los datos del primer firmante (forge no los interpreta por sí mismo). */
function parseSigner(root: forge.asn1.Asn1): ParsedSigner | null {
  const content = (root.value as forge.asn1.Asn1[])[1]; // [0] EXPLICIT
  const signedData = (content?.value as forge.asn1.Asn1[] | undefined)?.[0];
  const children = signedData?.value as forge.asn1.Asn1[] | undefined;
  if (!children) return null;
  const signerInfos = [...children]
    .reverse()
    .find(
      (child) =>
        child.tagClass === forge.asn1.Class.UNIVERSAL && child.type === forge.asn1.Type.SET,
    );
  const info = (signerInfos?.value as forge.asn1.Asn1[] | undefined)?.[0];
  const fields = info?.value as forge.asn1.Asn1[] | undefined;
  if (!fields || fields.length < 5) return null;

  const issuerAndSerial = fields[1]?.value as forge.asn1.Asn1[] | undefined;
  const serial = issuerAndSerial?.[1]?.value;
  const digestOid = forge.asn1.derToOid(
    ((fields[2]?.value as forge.asn1.Asn1[])[0] as forge.asn1.Asn1).value as string,
  );
  const authenticated = fields.find(
    (f) => f.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && f.type === 0,
  );
  const signature = [...fields]
    .reverse()
    .find(
      (f) => f.tagClass === forge.asn1.Class.UNIVERSAL && f.type === forge.asn1.Type.OCTETSTRING,
    );
  if (!authenticated || !signature || typeof serial !== 'string') return null;
  return {
    authenticated: authenticated.value as forge.asn1.Asn1[],
    digestOid,
    serialHex: forge.util.bytesToHex(serial),
    signature: signature.value as string,
  };
}

function attribute(attributes: forge.asn1.Asn1[], oid: string): forge.asn1.Asn1 | undefined {
  for (const attr of attributes) {
    const parts = attr.value as forge.asn1.Asn1[];
    if (forge.asn1.derToOid(parts[0]?.value as string) === oid) {
      return (parts[1]?.value as forge.asn1.Asn1[])[0];
    }
  }
  return undefined;
}

function unreadable(index: number, note: string): SignatureReport {
  return {
    index,
    signer: '',
    issuer: '',
    signedAt: '',
    reason: '',
    location: '',
    integrity: 'unreadable',
    coversWholeDocument: false,
    selfSigned: false,
    expiredWhenSigned: false,
    fingerprint: '',
    notes: [note],
  };
}

/** Comprueba cada firma digital del documento: el contenido firmado, la firma y el certificado. */
export function verifySignatures(data: Uint8Array): SignatureReport[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = bytes.toString('latin1');
  const reports: SignatureReport[] = [];
  const pattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const index = reports.length + 1;
    const [a, b, c, d] = [1, 2, 3, 4].map((i) => Number(match![i]));
    if (
      [a, b, c, d].some((n) => n === undefined || Number.isNaN(n)) ||
      a! + b! > c! ||
      c! + d! > bytes.length
    ) {
      reports.push(unreadable(index, 'El rango firmado no es válido.'));
      continue;
    }
    const gap = text.slice(a! + b!, c!);
    const hex = gap
      .replace(/^[^<]*</, '')
      .replace(/>[^>]*$/, '')
      .trim();
    if (hex === '' || /^0+$/.test(hex)) {
      reports.push(unreadable(index, 'La firma está vacía (aún no se firmó).'));
      continue;
    }

    try {
      // El diccionario de la firma: lo que hay antes de /ByteRange y lo que sigue a /Contents (un hueco
      // de decenas de kilobytes), donde están /Reason, /Location y /M.
      const window =
        text.slice(Math.max(0, match.index - 1500), match.index + 300) + text.slice(c!, c! + 2000);
      const notes: string[] = [];
      // @types/node-forge solo declara un booleano; en ejecución admite opciones. «parseAllBytes: false» tolera
      // los ceros de relleno con los que se reserva el hueco de la firma.
      const fromDer = forge.asn1.fromDer as unknown as (
        bytes: string,
        options: { strict: boolean; parseAllBytes: boolean },
      ) => forge.asn1.Asn1;
      const root = fromDer(forge.util.hexToBytes(hex), { strict: false, parseAllBytes: false });
      const message = forge.pkcs7.messageFromAsn1(root) as forge.pkcs7.PkcsSignedData;
      const signer = parseSigner(root);
      if (!signer) throw new Error('Sin datos de firmante');

      // 1) ¿El contenido firmado sigue igual?
      const algorithm = HASHES[signer.digestOid];
      if (!algorithm) throw new Error(`Algoritmo de resumen no admitido (${signer.digestOid})`);
      const signedContent = Buffer.concat([
        bytes.subarray(a!, a! + b!),
        bytes.subarray(c!, c! + d!),
      ]);
      const digest = createHash(algorithm).update(signedContent).digest();
      const declared = attribute(signer.authenticated, OID.messageDigest)?.value;
      const digestMatches =
        typeof declared === 'string' && Buffer.from(declared, 'binary').equals(digest);

      // 2) ¿La firma corresponde al certificado?
      const cert =
        message.certificates.find(
          (candidate) =>
            stripLeadingZeros(candidate.serialNumber) === stripLeadingZeros(signer.serialHex),
        ) ?? message.certificates[0];
      if (!cert) throw new Error('El PDF no incluye el certificado del firmante');
      const attrs = forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SET,
        true,
        signer.authenticated,
      );
      const md = forge.md[algorithm].create();
      md.update(forge.asn1.toDer(attrs).getBytes());
      let signatureValid = false;
      try {
        signatureValid = (cert.publicKey as forge.pki.rsa.PublicKey).verify(
          md.digest().bytes(),
          signer.signature,
        );
      } catch {
        signatureValid = false;
      }

      // 3) Datos del firmante y del documento
      const timeAttr = attribute(signer.authenticated, OID.signingTime);
      let signedAt = '';
      if (typeof timeAttr?.value === 'string') {
        const date =
          timeAttr.type === forge.asn1.Type.UTCTIME
            ? forge.asn1.utcTimeToDate(timeAttr.value)
            : forge.asn1.generalizedTimeToDate(timeAttr.value);
        signedAt = date.toISOString();
      }
      const when = signedAt ? new Date(signedAt) : new Date();
      const expiredWhenSigned = when < cert.validity.notBefore || when > cert.validity.notAfter;

      let selfSigned = false;
      try {
        selfSigned = cert.isIssuer(cert) && cert.verify(cert);
      } catch {
        selfSigned = false;
      }

      // ¿Se añadió algo después de firmar? (la firma debe llegar hasta el final del archivo)
      const trailing = bytes
        .subarray(c! + d!)
        .toString('latin1')
        .trim();
      const coversWholeDocument = trailing === '';
      if (!coversWholeDocument) notes.push('Se añadió contenido después de esta firma.');
      if (selfSigned)
        notes.push('Certificado autofirmado: no lo emitió una autoridad de confianza.');
      else notes.push('No se comprobó la cadena de confianza del certificado ni su revocación.');
      if (expiredWhenSigned)
        notes.push('El certificado no estaba vigente en el momento de firmar.');
      notes.push('La fecha de la firma es la del equipo del firmante (sin sello de tiempo).');

      reports.push({
        index,
        signer: cn(cert.subject),
        issuer: cn(cert.issuer),
        signedAt,
        reason: dictString(window, 'Reason'),
        location: dictString(window, 'Location'),
        integrity: !digestMatches ? 'modified' : signatureValid ? 'valid' : 'invalid',
        coversWholeDocument,
        selfSigned,
        expiredWhenSigned,
        fingerprint: fingerprintOf(cert),
        notes,
      });
    } catch (error) {
      reports.push(
        unreadable(index, `No se pudo interpretar la firma: ${(error as Error).message}`),
      );
    }
  }
  return reports;
}

/** ¿Contiene el documento alguna firma? (comprobación rápida por contenido) */
export function mayContainSignatures(data: Uint8Array): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes('/ByteRange');
}

// ---------------------------------------------------------------------------
// Certificado autofirmado
// ---------------------------------------------------------------------------

/** Crea un certificado autofirmado (RSA 2048, SHA-256) y lo devuelve como .p12 con su huella. */
export function createSelfSignedCertificate(request: NewCertificate): {
  p12: Uint8Array;
  fingerprint: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(privateKey);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + request.days * 24 * 3600 * 1000);

  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: request.commonName }];
  if (request.organization.trim())
    attrs.push({ name: 'organizationName', value: request.organization });
  if (request.email.trim()) attrs.push({ name: 'emailAddress', value: request.email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());

  // 3DES para que Windows y Acrobat puedan importar el archivo si el usuario lo necesita.
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], request.passphrase, {
    algorithm: '3des',
    friendlyName: request.commonName,
  });
  const der = forge.asn1.toDer(p12).getBytes();
  return { p12: new Uint8Array(Buffer.from(der, 'binary')), fingerprint: fingerprintOf(cert) };
}

export { toBinary as _toBinary };
