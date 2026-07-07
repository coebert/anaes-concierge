create or replace function public.get_competency_eligibility(p_on_date date default current_date)
returns table(
  specialty_id uuid,
  specialty_name text,
  staff_id uuid,
  full_name text,
  grade staff_grade,
  eligible_solo boolean,
  eligible_supervising boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with active_holdings as (
    select sc.staff_id, sc.competency_id, sc.level
      from public.staff_competencies sc
     where sc.granted_at <= p_on_date
       and (sc.revoked_at is null or sc.revoked_at > p_on_date)
       and (sc.expires_at is null or sc.expires_at >= p_on_date)
  ),
  req_solo as (
    select specialty_id, competency_id
      from public.specialty_competency_requirements
     where requirement = 'required'
       and applies_to_role in ('solo', 'any')
  ),
  req_sup as (
    select specialty_id, competency_id
      from public.specialty_competency_requirements
     where requirement = 'required'
       and applies_to_role in ('supervising', 'any')
  ),
  staff_pool as (
    select p.id as staff_id, p.full_name, p.grade
      from public.profiles p
     where p.active = true
  ),
  solo_eligible as (
    select sp.staff_id, s.id as specialty_id
      from staff_pool sp
      cross join public.specialties s
     where not exists (
       select 1 from req_solo r
        where r.specialty_id = s.id
          and not exists (
            select 1 from active_holdings h
             where h.staff_id = sp.staff_id
               and h.competency_id = r.competency_id
               and (h.level is null or h.level <> 'supervised')
          )
     )
  ),
  sup_eligible as (
    select sp.staff_id, s.id as specialty_id
      from staff_pool sp
      cross join public.specialties s
     where not exists (
       select 1 from req_sup r
        where r.specialty_id = s.id
          and not exists (
            select 1 from active_holdings h
             where h.staff_id = sp.staff_id
               and h.competency_id = r.competency_id
          )
     )
  )
  select s.id as specialty_id,
         s.name as specialty_name,
         sp.staff_id,
         sp.full_name,
         sp.grade,
         exists(select 1 from solo_eligible e where e.staff_id = sp.staff_id and e.specialty_id = s.id) as eligible_solo,
         exists(select 1 from sup_eligible  e where e.staff_id = sp.staff_id and e.specialty_id = s.id) as eligible_supervising
    from public.specialties s
    cross join staff_pool sp
   order by s.name, sp.full_name;
$$;

grant execute on function public.get_competency_eligibility(date) to authenticated;