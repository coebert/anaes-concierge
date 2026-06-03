import { predictTraineeStartDatesImpl } from "../src/lib/trainee-start-dates.functions";
(async () => {
  const r = await predictTraineeStartDatesImpl();
  console.log(JSON.stringify(r, null, 2));
})();
