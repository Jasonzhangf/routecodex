use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ForwarderTargetManifest, V3ProviderManifest,
    V3ProviderRequestCleanupAuthoringConfig, V3ReasoningEffort, V3ResponsesTransportKind,
    V3RouteGroupManifest, V3RoutePoolTargetManifest, V3RouteTargetKind, V3SelectionStrategy,
    V3WebSearchExecutionMode,
};
use routecodex_v3_provider_responses::{V3ProviderAvailabilityReader, V3ProviderSchedulingReader};
use routecodex_v3_virtual_router::{priority_tier_indices, V3Router07OpaqueTargetHitOnce};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

mod sticky;

pub use sticky::{
    V3StickyBinding, V3StickyKey, V3StickyMember, V3StickySelection, V3StickySelectionScope,
    V3StickySelectionState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target08KindClassified {
    pub route: V3Router07OpaqueTargetHitOnce,
}

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3TargetCandidate {
    pub provider_id: String,
    pub interface_id: String,
    pub provider_type: String,
    pub auth_alias: String,
    pub model_id: String,
    pub wire_model: String,
    pub visible_model_ids: Vec<String>,
    pub model_capabilities: Vec<String>,
    pub model_availability:
        Option<routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig>,
    pub web_search_execution_mode: V3WebSearchExecutionMode,
    pub max_context_tokens: Option<u64>,
    pub max_tokens: Option<u64>,
    pub context_token_estimate_scale_bps: u64,
    pub base_url: String,
    pub responses_process: Option<String>,
    pub responses_transport: V3ResponsesTransportKind,
    pub websocket_v2_url: Option<String>,
    pub provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig,
    pub reasoning_effort: Option<V3ReasoningEffort>,
    pub request_timeout_ms: u64,
    pub sse_first_frame_timeout_ms: Option<u64>,
    pub initial_concurrency_budget: u32,
    pub concurrency_acquire_timeout_ms: u64,
    pub compatibility_profile: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub env_name: Option<String>,
    pub token_file: Option<String>,
    pub secret_file: Option<String>,
    pub secret_key: Option<String>,
    pub api_key: Option<String>,
    pub oauth_declaration: Option<routecodex_v3_config::V3OAuthDeclaration>,
    pub required_capabilities: Vec<String>,
    pub priority: i32,
    pub weight: u32,
    pub pool_ids: Vec<String>,
    pub default_pool_member: bool,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target09CandidateSetExpanded {
    pub route: V3Router07OpaqueTargetHitOnce,
    pub candidates: Vec<V3TargetCandidate>,
    pub provider_priority_schedule: routecodex_v3_config::V3ProviderPriorityScheduleAuthoringConfig,
    pub route_pool_tier_priorities: BTreeMap<String, Vec<i32>>,
    /// Declared member identity of each pool that participated in the target
    /// plan, expanded without request-scoped filters (`requested_model_filter`,
    /// capability or availability). Session-sticky bindings prune against this
    /// set so a request that only makes part of a pool eligible cannot evict
    /// the session's remembered provider.
    pub sticky_pool_members: BTreeMap<String, Vec<V3StickyMember>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target10ConcreteProviderSelected {
    pub route: V3Router07OpaqueTargetHitOnce,
    pub candidate: V3TargetCandidate,
    pub candidate_count: usize,
    pub unavailable_candidates: Vec<String>,
    pub attempts: usize,
    pub default_floor_protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("selected target exhausted after {attempted_candidates:?}")]
pub struct V3TargetExhaustion {
    pub route: Box<V3Router07OpaqueTargetHitOnce>,
    pub attempted_candidates: Vec<String>,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum V3TargetError {
    #[error("route group or default pool is absent for selected target")]
    SelectedPoolMissing,
    #[error("selected opaque target index is invalid")]
    OpaqueTargetMissing,
    #[error("forwarder {0} is absent or disabled")]
    ForwarderMissing(String),
    #[error("forwarder cycle detected at {0}")]
    ForwarderCycle(String),
    #[error("provider target declaration is incomplete")]
    ProviderTargetIncomplete,
    #[error("provider {0} is absent or disabled")]
    ProviderMissing(String),
    #[error("provider {provider_id} model {model_id} is absent")]
    ModelMissing {
        provider_id: String,
        model_id: String,
    },
    #[error("provider {provider_id} auth key {auth_alias} is absent")]
    AuthMissing {
        provider_id: String,
        auth_alias: String,
    },
    #[error("provider {provider_id} interface {interface_id} is absent or disabled")]
    InterfaceMissing {
        provider_id: String,
        interface_id: String,
    },
    #[error("selected target has no concrete candidates")]
    CandidateSetEmpty,
}

#[derive(Debug, Clone, Default)]
pub struct V3TargetInterpreter {
    cursors: Arc<Mutex<BTreeMap<String, usize>>>,
}

/// Adapts legacy availability-only callers to the canonical health-aware
/// selector without creating a second selection algorithm.
pub struct V3AvailabilitySchedulingAdapter<'a, R> {
    availability: &'a R,
}

impl<'a, R: V3ProviderAvailabilityReader> V3AvailabilitySchedulingAdapter<'a, R> {
    pub fn new(availability: &'a R) -> Self {
        Self { availability }
    }
}

impl<R: V3ProviderAvailabilityReader> V3ProviderSchedulingReader
    for V3AvailabilitySchedulingAdapter<'_, R>
{
    fn scheduling_projection_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
        let availability = self.availability.availability_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        );
        let mut projection = routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            priority,
            1_000,
            base_weight,
        );
        projection.available = availability.available;
        projection.blocked_scopes = availability.blocked_scopes;
        projection
    }

    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
        let availability = self.availability.availability_for_interface(
            provider_id,
            "default",
            Some(auth_alias),
            Some(model_id),
            now_ms,
        );
        let mut projection = routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
            provider_id,
            "default",
            auth_alias,
            model_id,
            priority,
            1_000,
            base_weight,
        );
        projection.available = availability.available;
        projection.blocked_scopes = availability.blocked_scopes;
        projection
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3TargetExpansionScope {
    path: Vec<String>,
    pool_ids: Vec<String>,
    default_pool_member: bool,
    required_capabilities: Vec<String>,
    visible_model_ids: Vec<String>,
    interface_filter: Option<String>,
}

impl V3TargetInterpreter {
    pub fn classify_kind(&self, route: V3Router07OpaqueTargetHitOnce) -> V3Target08KindClassified {
        V3Target08KindClassified { route }
    }

    pub fn expand_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        classified: V3Target08KindClassified,
        deterministic_sample: u64,
    ) -> Result<V3Target09CandidateSetExpanded, V3TargetError> {
        let group = manifest
            .route_groups
            .get(&classified.route.routing_group_id)
            .ok_or(V3TargetError::SelectedPoolMissing)?;
        let mut candidates = Vec::new();
        let mut candidate_indices = BTreeMap::new();
        let mut last_error = None;
        let route_required_capabilities =
            selected_route_required_capabilities(group, &classified.route);
        for (plan_index, entry) in classified.route.target_plan.iter().enumerate() {
            // `provider.model` direct entries carry their own provider/model
            // pin and have no manifest pool to consult.
            if let Some((provider_id, model_id)) = &entry.direct_provider_model {
                match self.expand_provider(
                    manifest,
                    Some(provider_id),
                    Some(model_id),
                    None,
                    entry.interface.as_deref(),
                    entry.priority,
                    entry.weight,
                    deterministic_sample,
                    V3TargetExpansionScope {
                        path: vec![format!("direct:{provider_id}.{model_id}")],
                        pool_ids: vec![entry.pool_id.clone()],
                        default_pool_member: false,
                        required_capabilities: Vec::new(),
                        visible_model_ids: Vec::new(),
                        interface_filter: entry.interface.clone(),
                    },
                ) {
                    Ok(expanded) => {
                        for candidate in expanded {
                            let key = (
                                candidate.provider_id.clone(),
                                candidate.interface_id.clone(),
                                candidate.auth_alias.clone(),
                                candidate.model_id.clone(),
                                candidate_satisfies_required_capabilities(&candidate),
                            );
                            if let Some(index) = candidate_indices.get(&key).copied() {
                                merge_candidate_route_provenance(
                                    &mut candidates[index],
                                    &candidate,
                                );
                            } else {
                                candidate_indices.insert(key, candidates.len());
                                candidates.push(candidate);
                            }
                        }
                    }
                    Err(error) => {
                        last_error = Some(error);
                    }
                }
                continue;
            }
            let pool = group
                .pools
                .get(&entry.pool_id)
                .ok_or(V3TargetError::SelectedPoolMissing)?;
            let target = pool.targets.get(entry.target_index);
            let Some(target) = target else {
                last_error = Some(V3TargetError::OpaqueTargetMissing);
                continue;
            };
            let mut required_capabilities = route_required_capabilities.clone();
            // The default tier is reached after capability tiers are absent or
            // exhausted. ProviderReqCompat projects retained images to the
            // session placeholder for a selected text-only target.
            if entry.pool_id == "default" {
                required_capabilities.retain(|capability| {
                    !matches!(capability.as_str(), "web_search" | "multimodal" | "vision")
                });
            }
            let mut visited = BTreeSet::new();
            match self.expand_route_target(
                manifest,
                target,
                deterministic_sample.wrapping_add(plan_index as u64),
                &mut visited,
                V3TargetExpansionScope {
                    path: vec![format!("pool:{}", entry.pool_id)],
                    pool_ids: vec![entry.pool_id.clone()],
                    default_pool_member: entry.pool_id == "default",
                    required_capabilities,
                    visible_model_ids: Vec::new(),
                    interface_filter: entry.interface.clone(),
                },
            ) {
                Ok(expanded) => {
                    for candidate in expanded {
                        let key = (
                            candidate.provider_id.clone(),
                            candidate.interface_id.clone(),
                            candidate.auth_alias.clone(),
                            candidate.model_id.clone(),
                            candidate_satisfies_required_capabilities(&candidate),
                        );
                        if let Some(index) = candidate_indices.get(&key).copied() {
                            merge_candidate_route_provenance(&mut candidates[index], &candidate);
                        } else {
                            candidate_indices.insert(key, candidates.len());
                            candidates.push(candidate);
                        }
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }
        if candidates.is_empty() {
            return Err(last_error.unwrap_or(V3TargetError::CandidateSetEmpty));
        }
        let provider_priority_schedule = manifest
            .servers
            .get(&classified.route.server_id)
            .map(|server| server.provider_priority_schedule.clone())
            .unwrap_or_default();
        let mut route_pool_tiers = BTreeMap::<String, BTreeSet<i32>>::new();
        for candidate in &candidates {
            for pool_id in &candidate.pool_ids {
                // Synthetic pools (for example `implicit:<capability>` and
                // `direct`) have no declared route-pool tier list. They keep
                // their intrinsic candidate priority and are outside the
                // provider-priority schedule contract.
                if !group.pools.contains_key(pool_id) {
                    continue;
                }
                route_pool_tiers
                    .entry(pool_id.clone())
                    .or_default()
                    .insert(candidate.priority);
            }
        }
        let route_pool_tier_priorities = route_pool_tiers
            .into_iter()
            .map(|(pool_id, tiers)| {
                let mut priorities = tiers.into_iter().collect::<Vec<_>>();
                priorities.sort_unstable_by(|left, right| right.cmp(left));
                (pool_id, priorities)
            })
            .collect();
        let sticky_pool_members = Self::sticky_pool_members(manifest, group, &classified.route);
        Ok(V3Target09CandidateSetExpanded {
            route: classified.route,
            candidates,
            provider_priority_schedule,
            route_pool_tier_priorities,
            sticky_pool_members,
        })
    }

    /// Expands the configured members of every sticky pool in the target plan
    /// without request-scoped filters, so a session's remembered provider is
    /// never evicted by a request that only makes part of the pool eligible.
    fn sticky_pool_members(
        manifest: &V3Config05ManifestPublished,
        group: &V3RouteGroupManifest,
        route: &V3Router07OpaqueTargetHitOnce,
    ) -> BTreeMap<String, Vec<V3StickyMember>> {
        let mut members = BTreeMap::<String, BTreeMap<V3StickyKey, V3StickyMember>>::new();
        for (entry, pool) in route
            .target_plan
            .iter()
            .filter(|entry| entry.session_sticky)
            .filter_map(|entry| group.pools.get(&entry.pool_id).map(|pool| (entry, pool)))
        {
            let mut visited = BTreeSet::new();
            for target in &pool.targets {
                collect_sticky_members(
                    manifest,
                    target,
                    &mut visited,
                    &mut members.entry(entry.pool_id.clone()).or_default(),
                );
            }
        }
        members
            .into_iter()
            .map(|(pool_id, members)| {
                // Deterministic order: highest priority first, then weight,
                // then identity. A fresh session draws from the least-held
                // member; the tie-break only fixes a stable starting order.
                let mut ordered = members.into_values().collect::<Vec<_>>();
                ordered.sort_by(|left, right| {
                    right
                        .priority
                        .cmp(&left.priority)
                        .then_with(|| right.weight.cmp(&left.weight))
                        .then_with(|| left.key.cmp(&right.key))
                });
                (pool_id, ordered)
            })
            .collect()
    }

    pub fn ignores_single_candidate_automatic_cooldown(
        candidate_count: usize,
        blocked_scopes: &[String],
    ) -> bool {
        candidate_count == 1
            && !blocked_scopes.is_empty()
            && blocked_scopes.iter().all(|scope| {
                matches!(
                    scope.as_str(),
                    "provider_key_health_cooldown" | "provider_cooldown_probe_pending"
                )
            })
    }

    /// Whether `now_ms` falls inside the candidate's declared availability
    /// window. A candidate without a declared window is always inside it. This
    /// predicate is shared by admission, the direct send gate and real provider
    /// probes, so a probe cannot touch a minute that routing itself would
    /// refuse.
    pub fn candidate_in_availability_window(candidate: &V3TargetCandidate, now_ms: u64) -> bool {
        candidate
            .model_availability
            .as_ref()
            .is_none_or(|availability| availability.is_available_at(now_ms))
    }

    /// A candidate is admitted when its declared capabilities match the
    /// request and its provider-model availability window contains `now_ms`.
    /// This is the single admission basis shared by Target10 selection, the
    /// direct send gate, remaining-candidate accounting and recovery probes:
    /// every consumer must agree on which candidates the route can actually
    /// reach, or a candidate admitted by one stage is refused by another and a
    /// provider that was never contacted receives a health failure.
    pub fn candidate_admitted(candidate: &V3TargetCandidate, now_ms: u64) -> bool {
        candidate_satisfies_required_capabilities(candidate)
            && Self::candidate_in_availability_window(candidate, now_ms)
    }

    /// Number of candidates admitted by capability and declared availability.
    pub fn admitted_candidate_count(
        expanded: &V3Target09CandidateSetExpanded,
        now_ms: u64,
    ) -> usize {
        expanded
            .candidates
            .iter()
            .filter(|candidate| Self::candidate_admitted(candidate, now_ms))
            .count()
    }

    pub fn select_available_with_health<R: V3ProviderSchedulingReader>(
        &self,
        expanded: V3Target09CandidateSetExpanded,
        scheduling: &R,
        now_ms: u64,
        deterministic_sample: u64,
    ) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
        self.select_available_with_health_inner(
            expanded,
            scheduling,
            now_ms,
            deterministic_sample,
            None,
        )
    }

    /// Session-sticky admission of `select_available_with_health`.
    ///
    /// The sticky scope only reorders candidates inside the highest eligible
    /// route-tier/priority bucket; health, capability, availability and
    /// request-local exclusions keep their existing meaning. Without a sticky
    /// scope the plain weighted selection runs unchanged.
    pub fn select_available_with_health_sticky<R: V3ProviderSchedulingReader>(
        &self,
        expanded: V3Target09CandidateSetExpanded,
        scheduling: &R,
        now_ms: u64,
        deterministic_sample: u64,
        sticky: &V3StickySelectionScope,
    ) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
        self.select_available_with_health_inner(
            expanded,
            scheduling,
            now_ms,
            deterministic_sample,
            Some(sticky),
        )
    }

    fn select_available_with_health_inner<R: V3ProviderSchedulingReader>(
        &self,
        expanded: V3Target09CandidateSetExpanded,
        scheduling: &R,
        now_ms: u64,
        deterministic_sample: u64,
        sticky: Option<&V3StickySelectionScope>,
    ) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
        let mut unavailable = Vec::new();
        // Candidates of the sticky pool that this attempt cannot use because of
        // health, cooldown or a declared availability window. Only these hand
        // the main slot over; a request-local failure never does.
        let mut sticky_cooled = BTreeSet::new();
        let mut eligible = Vec::new();
        // Automatic-cooldown exemption counts only candidates still admitted by
        // capability and declared availability, so a window-inactive or
        // capability-mismatched sibling cannot inflate the pool size.
        let admitted_candidate_count = Self::admitted_candidate_count(&expanded, now_ms);
        for (index, candidate) in expanded.candidates.iter().enumerate() {
            if !candidate_satisfies_required_capabilities(candidate) {
                unavailable.push(format!(
                    "{}:{}:{}:capability_mismatch",
                    candidate.provider_id, candidate.auth_alias, candidate.model_id
                ));
                continue;
            }
            // Availability is declared on the provider model and is not a
            // fallback tier: outside its windows the candidate is not eligible.
            if !Self::candidate_admitted(candidate, now_ms) {
                unavailable.push(format!(
                    "{}:{}:{}:{}:availability_inactive",
                    candidate.provider_id,
                    candidate.interface_id,
                    candidate.auth_alias,
                    candidate.model_id
                ));
                sticky_cooled.insert(V3StickyKey::new(
                    &candidate.provider_id,
                    &candidate.auth_alias,
                    &candidate.model_id,
                ));
                continue;
            }
            // The context estimate is advisory ordering evidence, never an
            // admission boundary or provider refusal. Preserve health,
            // capability and request-local exclusion; demote an eligible
            // candidate only inside its route tier when its scaled estimate
            // is near or above its declared window.
            let near_limit =
                context_window_exceeded_reason(expanded.route.request_input_tokens, candidate)
                    .is_some()
                    || context_window_near_limit_reason(
                        expanded.route.request_input_tokens,
                        candidate,
                    )
                    .is_some();
            // Earlier route tiers have precedence over later/default tiers.
            // Keep that precedence while candidate priority itself is ordered
            // descending (larger configured values win).
            let route_tier_index = Self::route_tier_index_for_candidate(&expanded.route, candidate);
            let route_tier_rank = expanded
                .route
                .target_plan
                .len()
                .saturating_sub(route_tier_index);
            let route_priority = (route_tier_rank as i32).saturating_mul(1_000_000);
            let mut projection = scheduling.scheduling_projection_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                &candidate.auth_alias,
                &candidate.model_id,
                candidate.priority,
                candidate.weight,
                now_ms,
            );
            // A configured singleton does not participate in automatic health
            // scheduling. Keep manual auth, capacity and request-local blocks.
            if !projection.available
                && Self::ignores_single_candidate_automatic_cooldown(
                    admitted_candidate_count,
                    &projection.blocked_scopes,
                )
            {
                projection.available = true;
                projection.blocked_scopes.clear();
            }
            let scheduled_priority =
                self.provider_priority_schedule_priority(&expanded, candidate, now_ms);
            projection.effective_priority = projection
                .effective_priority
                .saturating_add(scheduled_priority.saturating_sub(candidate.priority));
            projection.effective_priority =
                route_priority.saturating_add(projection.effective_priority);
            if projection.available {
                eligible.push((
                    index,
                    candidate,
                    projection,
                    route_tier_rank,
                    scheduled_priority,
                    near_limit,
                ));
            } else {
                // A request-local failure is only a per-attempt exclusion. Any
                // health, quota, capacity or declared-availability block hands
                // the sticky main slot over.
                if sticky.is_some()
                    && projection
                        .blocked_scopes
                        .iter()
                        .any(|scope| scope != "request_local_provider_failure")
                {
                    sticky_cooled.insert(V3StickyKey::new(
                        &candidate.provider_id,
                        &candidate.auth_alias,
                        &candidate.model_id,
                    ));
                }
                unavailable.push(format_candidate_scheduling_unavailable(
                    candidate,
                    &projection,
                ));
            }
        }
        // The attempt budget includes the text candidates that become
        // selectable after the available vision candidates fail.
        let candidate_count = eligible.len().max(1);
        // A text-only default candidate may project images only after every
        // captured, available vision candidate has been exhausted.
        if expanded
            .route
            .request_capabilities
            .iter()
            .any(|capability| matches!(capability.as_str(), "multimodal" | "vision"))
            && eligible.iter().any(|(_, candidate, _, _, _, _)| {
                candidate_has_required_capability(&candidate.model_capabilities, "multimodal")
            })
        {
            eligible.retain(|(_, candidate, _, _, _, _)| {
                candidate_has_required_capability(&candidate.model_capabilities, "multimodal")
            });
        }
        // A route pool can encode its configured tiers as target priority.
        // Plan tier index orders separate pools; scheduled priority orders the
        // tiers inside one pool. Near-limit is only a same-tier demotion, so it
        // cannot hand selection to a lower pool or a lower in-pool tier.
        let Some(max_route_tier_scope) = eligible
            .iter()
            .map(|(_, _, _, route_tier_rank, scheduled_priority, _)| {
                (*route_tier_rank, *scheduled_priority)
            })
            .max()
        else {
            return Err(V3TargetExhaustion {
                route: Box::new(expanded.route),
                attempted_candidates: unavailable,
            });
        };
        let highest_route_tier_has_normal = eligible.iter().any(
            |(_, _, _, route_tier_rank, scheduled_priority, near_limit)| {
                (*route_tier_rank, *scheduled_priority) == max_route_tier_scope && !*near_limit
            },
        );
        let mut candidates = eligible
            .into_iter()
            .filter(
                |(_, _, _, route_tier_rank, scheduled_priority, near_limit)| {
                    (*route_tier_rank, *scheduled_priority) == max_route_tier_scope
                        && (!highest_route_tier_has_normal || !*near_limit)
                },
            )
            .collect::<Vec<_>>();
        let Some(max_priority) = candidates
            .iter()
            .map(|(_, _, projection, _, _, _)| projection.effective_priority)
            .max()
        else {
            return Err(V3TargetExhaustion {
                route: Box::new(expanded.route),
                attempted_candidates: unavailable,
            });
        };
        let mut tier = candidates
            .drain(..)
            .filter(|(_, _, projection, _, _, _)| projection.effective_priority == max_priority)
            .collect::<Vec<_>>();
        // Session-sticky selection only applies to the final bucket when that
        // bucket belongs to a sticky pool. Other pools keep weighted sampling.
        let sticky_pools = expanded
            .route
            .target_plan
            .iter()
            .filter(|entry| entry.session_sticky)
            .map(|entry| entry.pool_id.clone())
            .collect::<BTreeSet<_>>();
        let sticky_chosen = sticky.and_then(|scope| {
            let tier_pool_id = tier.iter().find_map(|(_, candidate, _, _, _, _)| {
                candidate
                    .pool_ids
                    .iter()
                    .find(|pool_id| sticky_pools.contains(*pool_id))
            })?;
            let scope_key = scope.scope_key(tier_pool_id);
            // The sticky universe is the pool's declared member set, not the
            // per-request expansion: a request that only makes part of the pool
            // eligible (model filter, capability, availability) must not evict
            // the session's remembered provider from the pool.
            let universe = expanded
                .sticky_pool_members
                .get(tier_pool_id)
                .cloned()
                .unwrap_or_default();
            let universe_keys = universe
                .iter()
                .map(|member| member.key.clone())
                .collect::<BTreeSet<_>>();
            let eligible_keys = tier
                .iter()
                .map(|(_, candidate, _, _, _, _)| {
                    V3StickyKey::new(
                        &candidate.provider_id,
                        &candidate.auth_alias,
                        &candidate.model_id,
                    )
                })
                .collect::<BTreeSet<_>>();
            let cooled = sticky_cooled
                .iter()
                .filter(|key| universe_keys.contains(*key))
                .cloned()
                .collect::<BTreeSet<_>>();
            let selection = scope
                .state
                .select(&scope_key, &universe, &eligible_keys, &cooled)?;
            tier.iter().position(|(_, candidate, _, _, _, _)| {
                V3StickyKey::new(
                    &candidate.provider_id,
                    &candidate.auth_alias,
                    &candidate.model_id,
                ) == selection.chosen
            })
        });
        let chosen = match sticky_chosen {
            Some(index) => index,
            None => {
                let total_weight = tier
                    .iter()
                    .map(|(_, _, projection, _, _, _)| projection.effective_weight_milli)
                    .sum::<u64>();
                let mut point = deterministic_sample % total_weight.max(1);
                let mut weighted = 0;
                for (tier_index, (_, _, projection, _, _, _)) in tier.iter().enumerate() {
                    if point < projection.effective_weight_milli {
                        weighted = tier_index;
                        break;
                    }
                    point = point.saturating_sub(projection.effective_weight_milli);
                }
                weighted
            }
        };
        let (index, candidate, _, _, _, _) = tier.swap_remove(chosen);
        let mut route = expanded.route;
        if let Some(pool_id) = route
            .target_plan
            .iter()
            .find(|entry| candidate.pool_ids.contains(&entry.pool_id))
            .map(|entry| entry.pool_id.clone())
        {
            route.pool_id = pool_id;
        }
        Ok(V3Target10ConcreteProviderSelected {
            route,
            candidate: candidate.clone(),
            candidate_count,
            unavailable_candidates: unavailable,
            attempts: index + 1,
            default_floor_protected: false,
        })
    }

    /// Returns the captured route-plan tier containing a concrete candidate.
    ///
    /// Target owns this provenance lookup so runtime rescue logic can inspect
    /// tier precedence without copying route-plan semantics.
    pub fn route_tier_index_for_candidate(
        route: &V3Router07OpaqueTargetHitOnce,
        candidate: &V3TargetCandidate,
    ) -> usize {
        candidate
            .pool_ids
            .iter()
            .filter_map(|pool_id| {
                route
                    .target_plan
                    .iter()
                    .find(|entry| entry.pool_id == *pool_id)
                    .map(|entry| entry.tier_index)
            })
            .min()
            .unwrap_or(usize::MAX)
    }

    fn provider_priority_schedule_priority(
        &self,
        expanded: &V3Target09CandidateSetExpanded,
        candidate: &V3TargetCandidate,
        now_ms: u64,
    ) -> i32 {
        let Some(pool_id) = candidate.pool_ids.iter().find(|pool_id| {
            expanded
                .route
                .target_plan
                .iter()
                .any(|entry| &entry.pool_id == *pool_id)
        }) else {
            return candidate.priority;
        };
        let Some(tier_priorities) = expanded.route_pool_tier_priorities.get(pool_id) else {
            return candidate.priority;
        };
        expanded.provider_priority_schedule.priority_for_provider(
            &candidate.provider_id,
            candidate.priority,
            tier_priorities,
            now_ms,
        )
    }

    pub fn select_available<R: V3ProviderAvailabilityReader>(
        &self,
        expanded: V3Target09CandidateSetExpanded,
        availability: &R,
        now_ms: u64,
    ) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
        let scheduling = V3AvailabilitySchedulingAdapter::new(availability);
        let normalize = |candidates: &mut Vec<String>| {
            for unavailable in candidates {
                if let Some(candidate) = expanded.candidates.iter().find(|candidate| {
                    format!(
                        "{}:{}:{}:{}:health_cooldown",
                        candidate.provider_id,
                        candidate.interface_id,
                        candidate.auth_alias,
                        candidate.model_id
                    ) == *unavailable
                }) {
                    let projection = availability.availability_for_interface(
                        &candidate.provider_id,
                        &candidate.interface_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_ms,
                    );
                    *unavailable =
                        format_candidate_availability_unavailable(candidate, &projection);
                }
            }
        };
        let deterministic_sample = legacy_selection_sample(&expanded);
        match self.select_available_with_health(
            expanded.clone(),
            &scheduling,
            now_ms,
            deterministic_sample,
        ) {
            Ok(mut selected) => {
                normalize(&mut selected.unavailable_candidates);
                Ok(selected)
            }
            Err(mut exhausted) => {
                normalize(&mut exhausted.attempted_candidates);
                Err(exhausted)
            }
        }
    }

    fn expand_route_target(
        &self,
        manifest: &V3Config05ManifestPublished,
        target: &V3RoutePoolTargetManifest,
        sample: u64,
        visited: &mut BTreeSet<String>,
        scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        match target.kind {
            V3RouteTargetKind::ProviderModel => self.expand_provider(
                manifest,
                target.provider.as_deref(),
                target.model.as_deref(),
                target.key.as_deref(),
                target.interface.as_deref(),
                target.priority.unwrap_or(0),
                target.weight.unwrap_or(1),
                sample,
                scope,
            ),
            V3RouteTargetKind::Forwarder => self.expand_forwarder(
                manifest,
                target
                    .id
                    .as_deref()
                    .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                sample,
                visited,
                scope,
            ),
        }
    }

    fn expand_forwarder(
        &self,
        manifest: &V3Config05ManifestPublished,
        forwarder_id: &str,
        sample: u64,
        visited: &mut BTreeSet<String>,
        mut scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        if !visited.insert(forwarder_id.to_string()) {
            return Err(V3TargetError::ForwarderCycle(forwarder_id.to_string()));
        }
        scope.path.push(format!("forwarder:{forwarder_id}"));
        let forwarder = manifest
            .forwarders
            .get(forwarder_id)
            .filter(|forwarder| forwarder.enabled)
            .ok_or_else(|| V3TargetError::ForwarderMissing(forwarder_id.to_string()))?;
        // The forwarder model is the configured client-visible target identity.
        // Validation still happens at the provider layer after the nested wire
        // model is resolved.
        push_unique_visible_model_id(&mut scope.visible_model_ids, &forwarder.model);
        for alias in &forwarder.aliases {
            push_unique_visible_model_id(&mut scope.visible_model_ids, alias);
        }
        for target in &forwarder.targets {
            if let Some(model) = target.model.as_deref() {
                push_unique_visible_model_id(&mut scope.visible_model_ids, model);
            }
        }
        let order = self.policy_order(
            &forwarder.selection.strategy,
            &forwarder.targets,
            sample,
            forwarder_id,
        );
        let mut candidates = Vec::new();
        let mut last_error = None;
        for index in order {
            let target = &forwarder.targets[index];
            let nested = match target.kind {
                V3RouteTargetKind::ProviderModel => self.expand_provider(
                    manifest,
                    target.provider.as_deref(),
                    target.model.as_deref().or(Some(forwarder.model.as_str())),
                    target.key.as_deref(),
                    target.interface.as_deref(),
                    target.priority.unwrap_or(0),
                    target.weight.unwrap_or(1),
                    sample.wrapping_add(index as u64),
                    scope.clone(),
                ),
                V3RouteTargetKind::Forwarder => self.expand_forwarder(
                    manifest,
                    target
                        .id
                        .as_deref()
                        .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                    sample.wrapping_add(index as u64),
                    visited,
                    scope.clone(),
                ),
            };
            match nested {
                Ok(mut nested) => candidates.append(&mut nested),
                Err(error) => last_error = Some(error),
            }
        }
        visited.remove(forwarder_id);
        if candidates.is_empty() {
            Err(last_error.unwrap_or(V3TargetError::CandidateSetEmpty))
        } else {
            Ok(candidates)
        }
    }

    fn expand_provider(
        &self,
        manifest: &V3Config05ManifestPublished,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        key: Option<&str>,
        interface_id: Option<&str>,
        priority: i32,
        weight: u32,
        sample: u64,
        mut scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        let provider_id = provider_id.ok_or(V3TargetError::ProviderTargetIncomplete)?;
        let provider = manifest
            .providers
            .get(provider_id)
            .filter(|provider| provider.enabled)
            .ok_or_else(|| V3TargetError::ProviderMissing(provider_id.to_string()))?;
        let model_id = model_id
            .or_else(|| provider.models.keys().next().map(String::as_str))
            .ok_or_else(|| V3TargetError::ModelMissing {
                provider_id: provider_id.to_string(),
                model_id: "<route-model>".to_string(),
            })?;
        let model = provider
            .models
            .get(model_id)
            .ok_or_else(|| V3TargetError::ModelMissing {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            })?;
        let visible_model_ids = if scope.visible_model_ids.is_empty() {
            normalized_model_visible_ids(&model.id, &model.aliases, Some(&model.wire_name))
        } else {
            scope.visible_model_ids.clone()
        };
        scope.path.push(format!("provider:{provider_id}"));
        let entries = if let Some(key) = key {
            vec![provider
                .auth
                .entries
                .iter()
                .find(|entry| entry.alias == key)
                .ok_or_else(|| V3TargetError::AuthMissing {
                    provider_id: provider_id.to_string(),
                    auth_alias: key.to_string(),
                })?]
        } else {
            // 不指明 key：展开 provider 全部 auth entries（key1/key2/...）。
            // 同 priority 候选按序选第一个可用（select_available），若不轮换
            // 起点会永远命中第一个 key——用每请求 deterministic_sample
            // （request_id FNV hash）旋转展开起点，使多 key 轮流成为首选。
            let mut entries: Vec<_> = provider.auth.entries.iter().collect();
            let offset = (sample % entries.len() as u64) as usize;
            entries.rotate_left(offset);
            entries
        };
        let interfaces = if let Some(interface_id) = interface_id {
            vec![provider
                .interfaces
                .get(interface_id)
                .filter(|interface| interface.enabled)
                .ok_or_else(|| V3TargetError::InterfaceMissing {
                    provider_id: provider_id.to_string(),
                    interface_id: interface_id.to_string(),
                })?]
        } else {
            provider
                .interfaces
                .values()
                .filter(|interface| interface.enabled)
                .collect::<Vec<_>>()
        };
        Ok(entries
            .into_iter()
            .flat_map(|entry| {
                interfaces.iter().map(|interface| V3TargetCandidate {
                    provider_id: provider_id.to_string(),
                    interface_id: interface.id.clone(),
                    provider_type: interface.provider_type.clone(),
                    auth_alias: entry.alias.clone(),
                    model_id: model.id.clone(),
                    wire_model: model.wire_name.clone(),
                    visible_model_ids: visible_model_ids.clone(),
                    model_capabilities: model.capabilities.clone(),
                    model_availability: model.availability.clone(),
                    web_search_execution_mode: model.web_search_execution_mode,
                    max_context_tokens: model.max_context_tokens,
                    max_tokens: model.max_tokens,
                    context_token_estimate_scale_bps: model.context_token_estimate_scale_bps,
                    base_url: interface.base_url.clone(),
                    responses_process: interface
                        .responses
                        .as_ref()
                        .map(|responses| responses.process.clone()),
                    responses_transport: interface
                        .responses
                        .as_ref()
                        .map(|responses| responses.transport)
                        .unwrap_or_default(),
                    websocket_v2_url: interface
                        .responses
                        .as_ref()
                        .and_then(|responses| responses.websocket_v2_url.clone()),
                    provider_request_cleanup: provider.provider_request_cleanup.clone(),
                    reasoning_effort: provider.reasoning_effort,
                    request_timeout_ms: provider.request_timeout_ms,
                    sse_first_frame_timeout_ms: provider.sse_first_frame_timeout_ms,
                    initial_concurrency_budget: provider
                        .concurrency
                        .as_ref()
                        .map_or(40, |concurrency| concurrency.max_in_flight),
                    concurrency_acquire_timeout_ms: provider
                        .concurrency
                        .as_ref()
                        .map_or(60_000, |concurrency| concurrency.acquire_timeout_ms),
                    compatibility_profile: interface
                        .compatibility_profile
                        .clone()
                        .or_else(|| provider.compatibility_profile.clone()),
                    headers: provider.headers.clone(),
                    env_name: entry.env.clone(),
                    token_file: entry.token_file.clone(),
                    secret_file: entry.secret_file.clone(),
                    secret_key: entry.secret_key.clone(),
                    api_key: entry.api_key.clone(),
                    oauth_declaration: entry.oauth_declaration.clone(),
                    required_capabilities: scope.required_capabilities.clone(),
                    priority,
                    weight: weight.max(1),
                    pool_ids: scope.pool_ids.clone(),
                    default_pool_member: scope.default_pool_member,
                    path: scope.path.clone(),
                })
            })
            .collect())
    }

    fn policy_order(
        &self,
        strategy: &V3SelectionStrategy,
        targets: &[V3ForwarderTargetManifest],
        sample: u64,
        forwarder_id: &str,
    ) -> Vec<usize> {
        let mut order = (0..targets.len()).collect::<Vec<_>>();
        match strategy {
            V3SelectionStrategy::Priority => {
                order = priority_tier_indices(targets, |target| target.priority)
                    .into_iter()
                    .flatten()
                    .collect();
            }
            V3SelectionStrategy::Weighted => {
                order.clear();
                for mut tier in priority_tier_indices(targets, |target| target.priority) {
                    let total = tier
                        .iter()
                        .map(|index| u64::from(targets[*index].weight.unwrap_or(1)))
                        .sum::<u64>();
                    let mut point = sample % total;
                    let mut chosen = 0;
                    for (tier_index, target_index) in tier.iter().enumerate() {
                        let weight = u64::from(targets[*target_index].weight.unwrap_or(1));
                        if point < weight {
                            chosen = tier_index;
                            break;
                        }
                        point -= weight;
                    }
                    tier.rotate_left(chosen);
                    order.extend(tier);
                }
            }
            V3SelectionStrategy::RoundRobin => {
                let mut cursors = self.cursors.lock().expect("target cursor lock");
                let cursor = cursors.entry(forwarder_id.to_string()).or_default();
                let start = *cursor % targets.len();
                *cursor = cursor.wrapping_add(1);
                order.rotate_left(start);
            }
            // A forwarder target is not a concrete provider, so it has no
            // sticky identity. Order it deterministically by declared priority
            // and let the concrete provider selection downstream own stickiness.
            V3SelectionStrategy::Sticky => {
                order = priority_tier_indices(targets, |target| target.priority)
                    .into_iter()
                    .flatten()
                    .collect();
            }
        }
        order
    }
}

fn selected_route_required_capabilities(
    group: &V3RouteGroupManifest,
    route: &V3Router07OpaqueTargetHitOnce,
) -> Vec<String> {
    let mut capabilities = BTreeSet::new();
    for capability in &route.request_capabilities {
        capabilities.insert(capability.clone());
    }
    for entry in &route.target_plan {
        if entry.pool_id == "default" {
            continue;
        }
        let Some(pool) = group.pools.get(&entry.pool_id) else {
            continue;
        };
        let Some(rule) = &pool.match_rule else {
            continue;
        };
        for capability in &rule.required_capabilities {
            capabilities.insert(capability.clone());
        }
    }
    capabilities.into_iter().collect()
}

/// Collects the concrete `provider.model.key` members a sticky pool declares,
/// independent of the current request. Forwarder targets are followed
/// recursively; unknown providers/models/keys are skipped, because a member
/// that cannot be expanded cannot be bound either.
fn collect_sticky_members(
    manifest: &V3Config05ManifestPublished,
    target: &V3RoutePoolTargetManifest,
    visited: &mut BTreeSet<String>,
    members: &mut BTreeMap<V3StickyKey, V3StickyMember>,
) {
    match target.kind {
        V3RouteTargetKind::ProviderModel => {
            let (Some(provider_id), Some(model_id)) =
                (target.provider.as_deref(), target.model.as_deref())
            else {
                return;
            };
            let Some(provider) = manifest
                .providers
                .get(provider_id)
                .filter(|provider| provider.enabled)
            else {
                return;
            };
            if !provider.models.contains_key(model_id) {
                return;
            }
            for alias in declared_auth_aliases(provider, target.key.as_deref()) {
                let key = V3StickyKey::new(provider_id, &alias, model_id);
                members.entry(key.clone()).or_insert(V3StickyMember {
                    key,
                    weight: target.weight.unwrap_or(1).max(1),
                    priority: target.priority.unwrap_or(0),
                });
            }
        }
        V3RouteTargetKind::Forwarder => {
            let Some(forwarder_id) = target.id.as_deref() else {
                return;
            };
            if !visited.insert(forwarder_id.to_string()) {
                return;
            }
            if let Some(forwarder) = manifest
                .forwarders
                .get(forwarder_id)
                .filter(|forwarder| forwarder.enabled)
            {
                for nested in &forwarder.targets {
                    let nested_target = V3RoutePoolTargetManifest {
                        kind: nested.kind.clone(),
                        id: nested.id.clone(),
                        provider: nested.provider.clone(),
                        model: nested
                            .model
                            .clone()
                            .or_else(|| Some(forwarder.model.clone())),
                        key: nested.key.clone(),
                        interface: nested.interface.clone(),
                        priority: nested.priority,
                        weight: nested.weight,
                    };
                    collect_sticky_members(manifest, &nested_target, visited, members);
                }
            }
            visited.remove(forwarder_id);
        }
    }
}

/// Auth aliases a pool target can bind to. A pinned `key` yields only that
/// alias; an unpinned target yields every declared entry, matching the
/// expansion that produces one candidate per auth entry.
fn declared_auth_aliases(provider: &V3ProviderManifest, key: Option<&str>) -> Vec<String> {
    match key {
        Some(key) => provider
            .auth
            .entries
            .iter()
            .any(|entry| entry.alias == key)
            .then(|| vec![key.to_string()])
            .unwrap_or_default(),
        None => provider
            .auth
            .entries
            .iter()
            .map(|entry| entry.alias.clone())
            .collect(),
    }
}

fn normalized_model_visible_ids(
    model_id: &str,
    aliases: &[String],
    wire_name: Option<&str>,
) -> Vec<String> {
    let mut ids = Vec::new();
    push_unique_visible_model_id(&mut ids, model_id);
    // Aliases are client-visible names of the same provider model. Record
    // them, but never let them filter the selected route pool.
    for alias in aliases {
        push_unique_visible_model_id(&mut ids, alias);
    }
    // wire_name is the upstream wire model identity: a client requesting the
    // wire name must be able to match this provider's model even when its
    // local model id differs (e.g. distinct web_search execution mode
    // profiles sharing the same upstream model).
    if let Some(wire_name) = wire_name {
        push_unique_visible_model_id(&mut ids, wire_name);
    }
    ids
}

fn push_unique_visible_model_id(ids: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() || ids.iter().any(|existing| existing == value) {
        return;
    }
    ids.push(value.to_string());
}

fn merge_candidate_route_provenance(
    existing: &mut V3TargetCandidate,
    duplicate: &V3TargetCandidate,
) {
    for pool_id in &duplicate.pool_ids {
        if !existing.pool_ids.iter().any(|existing| existing == pool_id) {
            existing.pool_ids.push(pool_id.clone());
        }
    }
    for capability in &duplicate.required_capabilities {
        if !existing
            .required_capabilities
            .iter()
            .any(|existing| existing == capability)
        {
            existing.required_capabilities.push(capability.clone());
        }
    }
    for visible_id in &duplicate.visible_model_ids {
        if !existing
            .visible_model_ids
            .iter()
            .any(|existing| existing == visible_id)
        {
            existing.visible_model_ids.push(visible_id.clone());
        }
    }
    existing.default_pool_member |= duplicate.default_pool_member;
}

fn candidate_satisfies_required_capabilities(candidate: &V3TargetCandidate) -> bool {
    candidate
        .required_capabilities
        .iter()
        .all(|required| candidate_has_required_capability(&candidate.model_capabilities, required))
}

fn legacy_selection_sample(expanded: &V3Target09CandidateSetExpanded) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for value in [
        expanded.route.server_id.as_str(),
        expanded.route.routing_group_id.as_str(),
        expanded.route.pool_id.as_str(),
    ] {
        for byte in value.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn context_window_exceeded_reason(
    request_input_tokens: u64,
    candidate: &V3TargetCandidate,
) -> Option<String> {
    let max_context_tokens = candidate.max_context_tokens?;
    let scaled_input_tokens = ((u128::from(request_input_tokens)
        * u128::from(candidate.context_token_estimate_scale_bps)
        + 9_999)
        / 10_000)
        .min(u128::from(u64::MAX)) as u64;
    (scaled_input_tokens > max_context_tokens).then(|| {
        format!(
            "{}:{}:{}:context_window_exceeded(input_tokens={},max_context_tokens={})",
            candidate.provider_id,
            candidate.auth_alias,
            candidate.model_id,
            scaled_input_tokens,
            max_context_tokens
        )
    })
}

fn context_window_near_limit_reason(
    request_input_tokens: u64,
    candidate: &V3TargetCandidate,
) -> Option<String> {
    let max_context_tokens = candidate.max_context_tokens?;
    let scaled_input_tokens = scaled_context_input_tokens(candidate, request_input_tokens);
    (u128::from(scaled_input_tokens) * 100 >= u128::from(max_context_tokens) * 90).then(|| {
        format!(
            "{}:{}:{}:context_window_near_limit(input_tokens={},max_context_tokens={})",
            candidate.provider_id,
            candidate.auth_alias,
            candidate.model_id,
            scaled_input_tokens,
            max_context_tokens
        )
    })
}

fn scaled_context_input_tokens(candidate: &V3TargetCandidate, request_input_tokens: u64) -> u64 {
    ((u128::from(request_input_tokens) * u128::from(candidate.context_token_estimate_scale_bps)
        + 9_999)
        / 10_000)
        .min(u128::from(u64::MAX)) as u64
}

fn candidate_has_required_capability(capabilities: &[String], required: &str) -> bool {
    let has = |wanted: &str| capabilities.iter().any(|capability| capability == wanted);
    match required {
        "search" | "web_search" => has("web_search"),
        "multimodal" | "vision" => has("multimodal") || has("vision"),
        _ => true,
    }
}

fn format_candidate_availability_unavailable(
    candidate: &V3TargetCandidate,
    projection: &routecodex_v3_provider_responses::V3ProviderAvailabilityProjection,
) -> String {
    let key = format!(
        "{}:{}:{}:{}",
        candidate.provider_id, candidate.interface_id, candidate.auth_alias, candidate.model_id
    );
    if projection.blocked_scopes.is_empty() {
        return key;
    }
    format!(
        "{}:availability({})",
        key,
        projection.blocked_scopes.join("|")
    )
}

fn format_candidate_scheduling_unavailable(
    candidate: &V3TargetCandidate,
    projection: &routecodex_v3_provider_responses::V3ProviderSchedulingProjection,
) -> String {
    let key = format!(
        "{}:{}:{}:{}",
        candidate.provider_id, candidate.interface_id, candidate.auth_alias, candidate.model_id
    );
    if projection.blocked_scopes.is_empty() {
        return format!("{key}:health_cooldown");
    }
    format!(
        "{}:availability({})",
        key,
        projection.blocked_scopes.join("|")
    )
}
