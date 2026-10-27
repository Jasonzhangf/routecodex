//! Session-sticky provider selection state.
//!
//! A sticky pool keeps one primary/standby pair per `(server, group, pool,
//! session)`. The standby slot prefers providers this session has already
//! used, so the pair stays inside a stable main/standby circle instead of
//! pulling a new provider in on every switch.
//!
//! A fresh session draws its pair from the members no other session holds
//! first, so different sessions spread over the pool instead of piling onto
//! the highest-weight member.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

/// Sticky identity of one concrete provider target: provider.model.key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3StickyKey(String);

impl V3StickyKey {
    pub fn new(provider_id: &str, auth_alias: &str, model_id: &str) -> Self {
        Self(format!("{provider_id}:{auth_alias}:{model_id}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One routable member of the sticky pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3StickyMember {
    pub key: V3StickyKey,
    pub weight: u32,
    pub priority: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3StickyBinding {
    pub primary: Option<V3StickyKey>,
    pub standby: Option<V3StickyKey>,
    /// Providers this session has used in this pool, most recent first.
    pub history: Vec<V3StickyKey>,
    /// Selection tick of the last use, for bounded state eviction.
    last_used: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3StickySelection {
    /// Provider this request must use.
    pub chosen: V3StickyKey,
    pub primary: V3StickyKey,
    pub standby: Option<V3StickyKey>,
}

/// Session-scoped sticky identity handed to Target10 selection. The sticky
/// pool and its strategy come from the captured route plan, so this scope only
/// carries who the session is.
#[derive(Debug, Clone)]
pub struct V3StickySelectionScope {
    pub server_id: String,
    pub routing_group_id: String,
    pub session_id: String,
    pub state: Arc<V3StickySelectionState>,
}

impl V3StickySelectionScope {
    pub fn new(
        server_id: impl Into<String>,
        routing_group_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            server_id: server_id.into(),
            routing_group_id: routing_group_id.into(),
            session_id: session_id.into(),
            state: V3StickySelectionState::process_shared(),
        }
    }

    pub fn scope_key(&self, pool_id: &str) -> String {
        V3StickySelectionState::scope_key(
            &self.server_id,
            &self.routing_group_id,
            pool_id,
            &self.session_id,
        )
    }
}

#[derive(Debug, Default)]
pub struct V3StickySelectionState {
    store: Mutex<V3StickyStore>,
}

#[derive(Debug, Default)]
struct V3StickyStore {
    bindings: BTreeMap<String, V3StickyBinding>,
    tick: u64,
}

const HISTORY_LIMIT: usize = 8;
const KEY_SEPARATOR: char = '\u{1f}';
/// Upper bound on remembered `(session, pool)` bindings. A client that never
/// sends a session id gets a fresh request-local key per request, so unbounded
/// growth here would leak. Evict the least recently used binding past this cap.
const MAX_BINDINGS: usize = 4096;

impl V3StickySelectionState {
    /// Process-wide state so a session keeps its pair across requests.
    pub fn process_shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<V3StickySelectionState>> = OnceLock::new();
        SHARED.get_or_init(|| Arc::new(Self::default())).clone()
    }

    pub fn scope_key(
        server_id: &str,
        routing_group_id: &str,
        pool_id: &str,
        session_id: &str,
    ) -> String {
        let separator = KEY_SEPARATOR.to_string();
        [server_id, routing_group_id, pool_id, session_id].join(&separator)
    }

    /// Chooses one member for this attempt.
    ///
    /// `universe` is every member the sticky pool can still route to, used to
    /// drop removed members from both slots. `eligible` is the subset this
    /// attempt may actually use after capability, availability, health and
    /// request-local checks; sticky only reorders inside it and never admits
    /// an excluded candidate. `cooled` marks universe members excluded by
    /// health or a declared availability window, because only those hand the
    /// main slot over; a request-local failure uses the standby for this
    /// attempt and keeps the pair.
    pub fn select(
        &self,
        scope_key: &str,
        universe: &[V3StickyMember],
        eligible: &BTreeSet<V3StickyKey>,
        cooled: &BTreeSet<V3StickyKey>,
    ) -> Option<V3StickySelection> {
        if eligible.is_empty() {
            return None;
        }
        let members = universe
            .iter()
            .map(|member| (member.key.clone(), member))
            .collect::<BTreeMap<_, _>>();
        let universe_keys = members.keys().cloned().collect::<BTreeSet<_>>();
        // Occupancy counts only this pool's other sessions, so pools stay
        // independent of each other.
        let pool_prefix = format!(
            "{}{KEY_SEPARATOR}",
            scope_key
                .rsplit_once(KEY_SEPARATOR)
                .map(|(prefix, _)| prefix)?
        );
        let mut store = self.store.lock().expect("sticky selection lock");
        let occupancy = pool_occupancy(&store.bindings, scope_key, &pool_prefix);
        let tick = store.tick.wrapping_add(1);
        store.tick = tick;
        let binding = store.bindings.entry(scope_key.to_string()).or_default();
        binding.history.retain(|key| universe_keys.contains(key));
        binding.primary = binding
            .primary
            .take()
            .filter(|key| universe_keys.contains(key));
        binding.standby = binding
            .standby
            .take()
            .filter(|key| universe_keys.contains(key));
        if binding.standby == binding.primary {
            binding.standby = None;
        }
        fill_pair(binding, &members, &universe_keys, &occupancy);

        let primary = binding.primary.clone()?;
        let standby = binding.standby.clone();
        let chosen = if eligible.contains(&primary) {
            primary.clone()
        } else if let Some(standby) = standby.filter(|key| eligible.contains(key)) {
            if cooled.contains(&primary) {
                binding.standby = Some(primary.clone());
                binding.primary = Some(standby.clone());
            }
            standby
        } else {
            // Neither slot is usable now. Use a replacement for this attempt
            // and leave the remembered pair untouched, so the main provider
            // returns as soon as it is usable again. `eligible` is non-empty
            // and the primary is not in it, so a replacement always exists.
            let mut candidates = eligible
                .iter()
                .filter(|key| **key != primary)
                .cloned()
                .collect::<Vec<_>>();
            candidates.sort_by(|left, right| rank_key(left, right, binding, &members, &occupancy));
            let replacement = candidates[0].clone();
            if cooled.contains(&primary) {
                binding.standby = Some(primary.clone());
                binding.primary = Some(replacement.clone());
            }
            replacement
        };
        binding.last_used = tick;
        binding.history.retain(|key| key != &chosen);
        binding.history.insert(0, chosen.clone());
        binding.history.truncate(HISTORY_LIMIT);
        // A standby that is now the primary would leave the pair with no
        // alternative; drop it so it can be refilled below.
        if binding.standby.as_ref() == binding.primary.as_ref() {
            binding.standby = None;
        }
        if binding.standby.is_none() && universe_keys.len() > 1 {
            fill_standby(binding, &members, &universe_keys, &occupancy);
        }
        let selection = V3StickySelection {
            chosen,
            primary: binding.primary.clone().unwrap_or(primary),
            standby: binding.standby.clone(),
        };
        evict_bindings(&mut store);
        Some(selection)
    }
}

/// Keeps the binding table bounded. Bindings not used for a long time are
/// dropped, which only means a later request starts a fresh pair.
fn evict_bindings(store: &mut V3StickyStore) {
    if store.bindings.len() <= MAX_BINDINGS {
        return;
    }
    let mut by_age = store
        .bindings
        .iter()
        .map(|(key, binding)| (binding.last_used, key.clone()))
        .collect::<Vec<_>>();
    by_age.sort();
    for (_, key) in by_age.into_iter().take(store.bindings.len() - MAX_BINDINGS) {
        store.bindings.remove(&key);
    }
}

fn pool_occupancy(
    bindings: &BTreeMap<String, V3StickyBinding>,
    scope_key: &str,
    pool_prefix: &str,
) -> BTreeMap<V3StickyKey, usize> {
    let mut occupancy = BTreeMap::<V3StickyKey, usize>::new();
    for (key, binding) in bindings {
        if key == scope_key || !key.starts_with(pool_prefix) {
            continue;
        }
        // Only the primary counts as "in use": a fresh session spreads over the
        // pool by picking a primary no other session currently uses. The
        // standby is the same session's backup, not another session's load.
        if let Some(primary) = &binding.primary {
            *occupancy.entry(primary.clone()).or_default() += 1;
        }
    }
    occupancy
}

/// Fills an empty pair. A fresh session draws from members no other session
/// holds, so sessions spread instead of stacking on one provider.
fn fill_pair(
    binding: &mut V3StickyBinding,
    members: &BTreeMap<V3StickyKey, &V3StickyMember>,
    universe: &BTreeSet<V3StickyKey>,
    occupancy: &BTreeMap<V3StickyKey, usize>,
) {
    if binding.primary.is_none() {
        let mut candidates = universe.iter().cloned().collect::<Vec<_>>();
        candidates.sort_by(|left, right| rank_key(left, right, binding, members, occupancy));
        binding.primary = candidates.first().cloned();
    }
    fill_standby(binding, members, universe, occupancy);
}

/// The standby prefers a provider this session already used, most recent
/// first; a never-used member only enters when no used member is left.
fn fill_standby(
    binding: &mut V3StickyBinding,
    members: &BTreeMap<V3StickyKey, &V3StickyMember>,
    universe: &BTreeSet<V3StickyKey>,
    occupancy: &BTreeMap<V3StickyKey, usize>,
) {
    if binding
        .standby
        .as_ref()
        .is_some_and(|standby| Some(standby) != binding.primary.as_ref())
    {
        return;
    }
    let mut used = binding
        .history
        .iter()
        .filter(|key| Some(*key) != binding.primary.as_ref() && universe.contains(*key))
        .cloned()
        .collect::<Vec<_>>();
    let mut candidates = if used.is_empty() {
        universe
            .iter()
            .filter(|key| Some(*key) != binding.primary.as_ref())
            .cloned()
            .collect::<Vec<_>>()
    } else {
        std::mem::take(&mut used)
    };
    candidates.sort_by(|left, right| rank_key(left, right, binding, members, occupancy));
    binding.standby = candidates.first().cloned();
}

/// Orders candidates by session history first (most recent wins), then by the
/// pool's own priority (higher wins, so a configured priority tier keeps its
/// precedence), then by the fewest other sessions holding them, then weight.
fn rank_key(
    left: &V3StickyKey,
    right: &V3StickyKey,
    binding: &V3StickyBinding,
    members: &BTreeMap<V3StickyKey, &V3StickyMember>,
    occupancy: &BTreeMap<V3StickyKey, usize>,
) -> std::cmp::Ordering {
    let history_rank = |key: &V3StickyKey| binding.history.iter().position(|used| used == key);
    history_rank(left)
        .cmp(&history_rank(right))
        .then_with(|| {
            let left_priority = members.get(left).map_or(0, |member| member.priority);
            let right_priority = members.get(right).map_or(0, |member| member.priority);
            right_priority.cmp(&left_priority)
        })
        .then_with(|| {
            occupancy
                .get(left)
                .copied()
                .unwrap_or(0)
                .cmp(&occupancy.get(right).copied().unwrap_or(0))
        })
        .then_with(|| {
            let left_weight = members.get(left).map_or(1, |member| member.weight);
            let right_weight = members.get(right).map_or(1, |member| member.weight);
            right_weight.cmp(&left_weight)
        })
        .then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(provider: &str) -> V3StickyKey {
        V3StickyKey::new(provider, "default", "model")
    }

    fn member(provider: &str) -> V3StickyMember {
        V3StickyMember {
            key: key(provider),
            weight: 1,
            priority: 0,
        }
    }

    fn universe(providers: &[&str]) -> Vec<V3StickyMember> {
        providers.iter().map(|provider| member(provider)).collect()
    }

    fn eligible(providers: &[&str]) -> BTreeSet<V3StickyKey> {
        providers.iter().map(|provider| key(provider)).collect()
    }

    fn cooled(providers: &[&str]) -> BTreeSet<V3StickyKey> {
        providers.iter().map(|provider| key(provider)).collect()
    }

    #[test]
    fn same_session_stays_on_primary() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["a", "b"]);
        let all = eligible(&["a", "b"]);
        let first = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(first.chosen, key("a"));
        assert_eq!(first.primary, key("a"));
        let second = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(
            second.chosen,
            key("a"),
            "the same session must keep its provider"
        );
    }

    #[test]
    fn different_sessions_spread_across_pool() {
        let state = V3StickySelectionState::default();
        let members = universe(&["a", "b", "c"]);
        let all = eligible(&["a", "b", "c"]);
        let first = state
            .select(
                &V3StickySelectionState::scope_key("srv", "grp", "pool", "s1"),
                &members,
                &all,
                &BTreeSet::new(),
            )
            .unwrap();
        let second = state
            .select(
                &V3StickySelectionState::scope_key("srv", "grp", "pool", "s2"),
                &members,
                &all,
                &BTreeSet::new(),
            )
            .unwrap();
        let third = state
            .select(
                &V3StickySelectionState::scope_key("srv", "grp", "pool", "s3"),
                &members,
                &all,
                &BTreeSet::new(),
            )
            .unwrap();
        assert_eq!(first.chosen, key("a"));
        assert_eq!(
            second.chosen,
            key("b"),
            "a fresh session must prefer an unheld member"
        );
        assert_eq!(
            third.chosen,
            key("c"),
            "each fresh session takes a distinct member"
        );
    }

    #[test]
    fn cooled_primary_rolls_to_standby() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["a", "b"]);
        let all = eligible(&["a", "b"]);
        let first = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(first.primary, key("a"));
        assert_eq!(first.standby, Some(key("b")));
        // "a" cools; only "b" is usable. The pair hands the main slot over.
        let rolled = state
            .select(&scope, &members, &eligible(&["b"]), &cooled(&["a"]))
            .unwrap();
        assert_eq!(rolled.chosen, key("b"));
        assert_eq!(rolled.primary, key("b"));
        assert_eq!(rolled.standby, Some(key("a")));
    }

    #[test]
    fn recovered_primary_does_not_pull_back() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["a", "b"]);
        let all = eligible(&["a", "b"]);
        state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        state
            .select(&scope, &members, &eligible(&["b"]), &cooled(&["a"]))
            .unwrap();
        // "a" recovers. Recovery is lazy: the session stays on "b".
        let after = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(
            after.chosen,
            key("b"),
            "primary recovery must not auto-revert"
        );
    }

    #[test]
    fn request_local_exclusion_does_not_roll_the_pair() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["a", "b"]);
        let all = eligible(&["a", "b"]);
        state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        // "a" is request-local excluded but NOT cooled: use "b" for this
        // attempt, keep "a" as the main slot.
        let attempt = state
            .select(&scope, &members, &eligible(&["b"]), &BTreeSet::new())
            .unwrap();
        assert_eq!(attempt.chosen, key("b"));
        assert_eq!(
            attempt.primary,
            key("a"),
            "request-local failure must not demote primary"
        );
        let next = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(next.chosen, key("a"));
    }

    #[test]
    fn single_member_pool_has_no_standby() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["only"]);
        let selection = state
            .select(&scope, &members, &eligible(&["only"]), &BTreeSet::new())
            .unwrap();
        assert_eq!(selection.chosen, key("only"));
        assert_eq!(selection.standby, None);
    }

    #[test]
    fn removed_member_is_refilled_from_remaining() {
        let state = V3StickySelectionState::default();
        let scope = V3StickySelectionState::scope_key("srv", "grp", "pool", "session");
        let members = universe(&["a", "b", "c"]);
        let all = eligible(&["a", "b", "c"]);
        let first = state
            .select(&scope, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(first.primary, key("a"));
        assert_eq!(first.standby, Some(key("b")));
        // "b" leaves the pool; the standby slot must refill from the rest.
        let smaller = universe(&["a", "c"]);
        let after = state
            .select(&scope, &smaller, &eligible(&["a", "c"]), &BTreeSet::new())
            .unwrap();
        assert_eq!(after.chosen, key("a"));
        assert_eq!(after.standby, Some(key("c")));
    }

    #[test]
    fn pools_do_not_share_occupancy() {
        let state = V3StickySelectionState::default();
        let members = universe(&["a", "b"]);
        let all = eligible(&["a", "b"]);
        let pool1 = V3StickySelectionState::scope_key("srv", "grp", "pool1", "s1");
        let pool2 = V3StickySelectionState::scope_key("srv", "grp", "pool2", "s1");
        let first = state
            .select(&pool1, &members, &all, &BTreeSet::new())
            .unwrap();
        let second = state
            .select(&pool2, &members, &all, &BTreeSet::new())
            .unwrap();
        assert_eq!(first.chosen, key("a"));
        assert_eq!(
            second.chosen,
            key("a"),
            "different pools must not affect each other"
        );
    }
}
