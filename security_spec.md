# WattappsAU Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Private FCM Token Isolation (`/devices/{userId}`)**: A device registration containing an FCM token can only be read, created, updated, or deleted by its authenticated owner (`request.auth.uid == userId`). Directory listing (`list`) is strictly denied.
2. **Peer Directory Integrity (`/peerDirectory/{peerId}`)**: A 6-digit peer ID entry (`^[0-9]{6}$`) can only be created, updated, or deleted by its verified `ownerUid == request.auth.uid`. Other authenticated peers may only perform single-document `get` lookups by exact 6-digit ID; collection `list` is strictly denied to prevent enumeration/scraping.
3. **Wake Signal Consistency & Terminal State (`/wakeSignals/{signalId}`)**:
   - A wake signal can only be created by an authenticated verified sender (`senderUid == request.auth.uid`) targeting a `recipientPeerId` that exists in `/peerDirectory/{recipientPeerId}` and whose `ownerUid` matches `recipientUid`.
   - Initial `status` MUST be `'pending'`, and `createdAt == request.time && updatedAt == request.time`.
   - Collection `list` queries are strictly constrained to `resource.data.recipientUid == request.auth.uid`.
   - Once `status` transitions to `'acknowledged'`, the document reaches a terminal state and rejects all subsequent updates.
4. **Strict Keys & Bounded Types**: Every write enforces `hasAll` + `hasOnly` (create) and `affectedKeys().hasOnly(...)` (update) along with `.size()` bounds on every string and regex validation on every ID.

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated Device Read**: Anonymous client calls `get(/devices/userA)`.
2. **Cross-User FCM Token Theft**: Authenticated `userB` calls `get(/devices/userA)` to steal `userA`'s FCM token.
3. **Shadow Field Injection on Device Create**: `userA` creates `/devices/userA` with extra ghost field `isAdmin: true`.
4. **Unverified Email Write**: Authenticated user with `email_verified: false` tries to create `/devices/userUnverified`.
5. **Directory Scraping (`list`)**: Authenticated `userB` queries `list(/peerDirectory)` to enumerate all 6-digit IDs.
6. **Peer ID Hijack**: `userB` tries to update `/peerDirectory/123456` owned by `userA` to swap `ownerUid`.
7. **ID Poisoning / Oversized Document ID**: `userA` writes to `/wakeSignals/` + 200-char junk ID string.
8. **Sender Spoofing on WakeSignal**: `userB` creates `/wakeSignals/sig1` with `senderUid: 'userA'`.
9. **Orphaned WakeSignal**: `userA` creates `/wakeSignals/sig2` pointing to a nonexistent `recipientPeerId: '999999'`.
10. **Timestamp Forgery**: `userA` creates `/wakeSignals/sig3` with a backdated client timestamp instead of `request.time`.
11. **Terminal State Mutation**: `userB` updates `/wakeSignals/sigAck` (already `status: 'acknowledged'`) back to `status: 'pending'`.
12. **Unauthorized Signal List Query**: `userB` lists `/wakeSignals` without filtering `recipientUid == userB`, attempting to read `userA`'s incoming wake queue.
