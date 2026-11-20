import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  getDocFromServer,
  type Firestore,
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);
const firestoreDatabaseId = firebaseConfig.firestoreDatabaseId || "(default)";

function createFirestoreClient(): Firestore {
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentSingleTabManager({ forceOwnership: true }),
        }),
      },
      firestoreDatabaseId,
    );
  } catch {
    return getFirestore(app, firestoreDatabaseId);
  }
}

export const db = createFirestoreClient();
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export const BOOTSTRAPPED_ADMIN_EMAIL = "villatama11@gmail.com";
export const BOOTSTRAPPED_ADMIN_EMAILS = [BOOTSTRAPPED_ADMIN_EMAIL] as const;

export function isBootstrappedAdminEmail(email?: string | null): boolean {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized === BOOTSTRAPPED_ADMIN_EMAIL;
}

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }
  try {
    await Promise.race([
      getDocFromServer(doc(db, "test", "connection")),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the client is offline (timeout)")), 3500),
      ),
    ]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (
      msg.includes("the client is offline") ||
      msg.includes("timeout") ||
      msg.includes("unavailable") ||
      msg.includes("network")
    ) {
      return false;
    }
    // Permission denied on /test/connection still confirms Firestore backend is reachable
    return true;
  }
}

export async function signInWithGooglePopup(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  const user = result.user;
  if (!user.emailVerified || !isBootstrappedAdminEmail(user.email)) {
    await signOut(auth);
    throw new Error(
      `Akses ditolak untuk ${user.email || "akun ini"}. Database Firebase hanya dapat diakses oleh akun ${BOOTSTRAPPED_ADMIN_EMAIL}.`,
    );
  }
  return user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}
