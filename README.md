# Anaesthesia Rota Ally

I want to build an AI-assisted rota coordination app for the anaesthetics department at Salisbury District General Hospital. The app needs to be able to understand the job plans and rules around working hours of all staff members on the rota, including consultants, SAS grade anesthetists and trainees. The app should have a global calendar view as well as the ability to view individual staff members' rotas. The app should be able to process and accommodate requests for different forms of leave, including annual, study and compassionate. The app needs to be able to remember key information on the working patterns of particular staff members, such as the number of PAs they work in a week, whether they are less than full time (and what percentage of full time they work), whether there are particular days or lists that they work regularly etc. Ideally, the app needs to be able to retrieve information on the current rota pattern from the CLWRota system (see https://sft.clwrota.com/). CLWRota allows connection to its Central API via an authentication key. I also want the app to have an AI chat feature whereby users can email questions about their rota or leave and the chat assistant will reply to them with the requested information. Anaesthetic trainees have particular training requirements, such as a particular number of days/lists spent in particular subspecialties, and particular numbers of directly supervised and solo lists. The app should be able to keep track of each trainee's requirements and whether the rota is allowing them to meet these. Salisbury District General Hospital has 10 main theaters (numbered one to ten) and three day surgery theaters (A, B and F). The app should allow admins to enter information on the surgical specialty and surgical consultant operating in particular theaters on particular days. Please note that theater operating lists are split into an 'am' and a 'pm' session

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://anaes-concierge.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/58d57e5a-3648-4d9e-b953-83e4bf950e52).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
