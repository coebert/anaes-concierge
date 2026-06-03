// Pure calculation engine for the consultant feasibility simulation.
// Extracted from the route component so it can be unit-tested in isolation.

export interface FeasibilityInputs {
  mainTheatres: number;
  daySurgeryTheatres: number;
  sessionsPerTheatrePerWeek: number;
  labourWardSessionsPerWeek: number;
  consultantInChargeSessionsPerWeek: number;
  painServiceSessionsPerWeek: number;
  poacSessionsPerWeek: number;
  nonClinicalPAsPerWeek: number;
  icuSessionsPerWeek: number;
  icuTrainedPoolSize: number;
  pasPerConsultant: number;
  dccPasPerConsultant: number;
  sessionsPerPa: number;
  annualLeaveDays: number;
  studyLeaveDays: number;
  bankHolidayDays: number;
  weeksPerYear: number;
  workingDaysPerWeek: number;
  sicknessRatePct: number;
  theatreOnCallPAsPerWeek: number;
  icuOnCallPAsPerWeek: number;
}

export interface FeasibilityResult {
  theatreSessions: number;
  weeklySessionDemand: number;
  weeklyDemand: number;
  annualDemand: number;
  annualOnCallSessionEquiv: number;
  weeklyOnCallPAs: number;
  leaveWeeks: number;
  workingWeeks: number;
  weeklyClinicalSessions: number;
  sicknessFactor: number;
  annualSessionsPerConsultant: number;
  fteNeeded: number;
  icuAnnualDemand: number;
  icuAnnualOnCallEquiv: number;
  icuPoolAnnualCapacity: number;
  icuPoolUtilisation: number;
  icuSharePerConsultant: number;
  grossAnnualSessionsPerConsultant: number;
  leaveLostAnnualSessionsPerConsultant: number;
  afterLeaveAnnualSessionsPerConsultant: number;
  sicknessLostAnnualSessionsPerConsultant: number;
  annualOnCallBurdenPerConsultant: number;
  residualListCapacityPerConsultant: number;
  icuDemandPerConsultant: number;
  icuResidualCapacityPerConsultant: number;
}

export function calculateFeasibility(inp: FeasibilityInputs): FeasibilityResult {
  const theatreSessions =
    (inp.mainTheatres + inp.daySurgeryTheatres) *
    inp.sessionsPerTheatrePerWeek;
  const weeklySessionDemand =
    theatreSessions +
    inp.labourWardSessionsPerWeek +
    inp.consultantInChargeSessionsPerWeek +
    inp.painServiceSessionsPerWeek +
    inp.poacSessionsPerWeek +
    inp.nonClinicalPAsPerWeek * inp.sessionsPerPa +
    inp.icuSessionsPerWeek;
  const annualSessionDemand = weeklySessionDemand * inp.weeksPerYear;

  const weeklyOnCallPAs =
    inp.theatreOnCallPAsPerWeek + inp.icuOnCallPAsPerWeek;
  const annualOnCallSessionEquiv =
    weeklyOnCallPAs * inp.sessionsPerPa * inp.weeksPerYear;

  const weeklyDemand =
    weeklySessionDemand + weeklyOnCallPAs * inp.sessionsPerPa;
  const annualDemand = annualSessionDemand + annualOnCallSessionEquiv;

  const leaveDays =
    inp.annualLeaveDays + inp.studyLeaveDays + inp.bankHolidayDays;
  const leaveWeeks = leaveDays / inp.workingDaysPerWeek;
  const workingWeeks = Math.max(0, inp.weeksPerYear - leaveWeeks);

  const weeklyClinicalSessions = inp.dccPasPerConsultant * inp.sessionsPerPa;
  const sicknessFactor = 1 - inp.sicknessRatePct / 100;
  const annualSessionsPerConsultant =
    weeklyClinicalSessions * workingWeeks * sicknessFactor;

  const fteNeeded =
    annualSessionsPerConsultant > 0
      ? annualDemand / annualSessionsPerConsultant
      : Infinity;

  const icuAnnualSessionDemand = inp.icuSessionsPerWeek * inp.weeksPerYear;
  const icuAnnualOnCallEquiv =
    inp.icuOnCallPAsPerWeek * inp.sessionsPerPa * inp.weeksPerYear;
  const icuAnnualDemand = icuAnnualSessionDemand + icuAnnualOnCallEquiv;
  const icuPoolAnnualCapacity =
    inp.icuTrainedPoolSize * annualSessionsPerConsultant;
  const icuPoolUtilisation =
    icuPoolAnnualCapacity > 0
      ? icuAnnualDemand / icuPoolAnnualCapacity
      : Infinity;
  const icuWeeklyLoad =
    inp.icuSessionsPerWeek + inp.icuOnCallPAsPerWeek * inp.sessionsPerPa;
  const icuSharePerConsultant =
    inp.icuTrainedPoolSize > 0 && weeklyClinicalSessions > 0
      ? icuWeeklyLoad / inp.icuTrainedPoolSize / weeklyClinicalSessions
      : Infinity;

  const grossAnnualSessionsPerConsultant =
    weeklyClinicalSessions * inp.weeksPerYear;
  const leaveLostAnnualSessionsPerConsultant =
    weeklyClinicalSessions * leaveWeeks;
  const afterLeaveAnnualSessionsPerConsultant =
    weeklyClinicalSessions * workingWeeks;
  const sicknessLostAnnualSessionsPerConsultant =
    afterLeaveAnnualSessionsPerConsultant - annualSessionsPerConsultant;
  const annualOnCallBurdenPerConsultant =
    fteNeeded > 0 && Number.isFinite(fteNeeded)
      ? annualOnCallSessionEquiv / fteNeeded
      : 0;
  const residualListCapacityPerConsultant =
    annualSessionsPerConsultant - annualOnCallBurdenPerConsultant;
  const icuDemandPerConsultant =
    inp.icuTrainedPoolSize > 0 ? icuAnnualDemand / inp.icuTrainedPoolSize : 0;
  const icuResidualCapacityPerConsultant =
    annualSessionsPerConsultant - icuDemandPerConsultant;

  return {
    theatreSessions,
    weeklySessionDemand,
    weeklyDemand,
    annualDemand,
    annualOnCallSessionEquiv,
    weeklyOnCallPAs,
    leaveWeeks,
    workingWeeks,
    weeklyClinicalSessions,
    sicknessFactor,
    annualSessionsPerConsultant,
    fteNeeded,
    icuAnnualDemand,
    icuAnnualOnCallEquiv,
    icuPoolAnnualCapacity,
    icuPoolUtilisation,
    icuSharePerConsultant,
    grossAnnualSessionsPerConsultant,
    leaveLostAnnualSessionsPerConsultant,
    afterLeaveAnnualSessionsPerConsultant,
    sicknessLostAnnualSessionsPerConsultant,
    annualOnCallBurdenPerConsultant,
    residualListCapacityPerConsultant,
    icuDemandPerConsultant,
    icuResidualCapacityPerConsultant,
  };
}

export const FEASIBILITY_DEFAULTS: FeasibilityInputs = {
  mainTheatres: 10,
  daySurgeryTheatres: 3,
  sessionsPerTheatrePerWeek: 10,
  labourWardSessionsPerWeek: 10,
  consultantInChargeSessionsPerWeek: 10,
  painServiceSessionsPerWeek: 5,
  poacSessionsPerWeek: 5,
  icuSessionsPerWeek: 10,
  icuTrainedPoolSize: 10,
  pasPerConsultant: 10,
  dccPasPerConsultant: 7.5,
  sessionsPerPa: 1,
  annualLeaveDays: 32,
  studyLeaveDays: 7,
  bankHolidayDays: 8,
  weeksPerYear: 52,
  workingDaysPerWeek: 5,
  sicknessRatePct: 5,
  theatreOnCallPAsPerWeek: 2,
  icuOnCallPAsPerWeek: 2,
};
