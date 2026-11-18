// The seven stations of the loop, shared by the hero ring and the step-by-step section.
export interface Station {
	key: string;
	label: string;
	screen: string;
	summary: string;
}

export const stations: Station[] = [
	{ key: 'brief', label: 'Brief', screen: 'ai-workspace', summary: 'Describe the project. Odin drafts the brief.' },
	{ key: 'questions', label: 'Questions', screen: 'requirements-topic', summary: 'Odin asks what the brief leaves open.' },
	{ key: 'review', label: 'Review', screen: 'requirements-review', summary: 'Stakeholders mark up real screens.' },
	{ key: 'decide', label: 'Decide', screen: 'requirements-results', summary: 'Decisions get numbers and sources.' },
	{ key: 'build', label: 'Build', screen: 'kanban', summary: 'The plan becomes sprints and a board.' },
	{ key: 'report', label: 'Report', screen: 'bug-reporter', summary: 'Testers report bugs from the live site.' },
	{ key: 'fix', label: 'Fix', screen: 'faultline', summary: 'FaultLine investigates and opens the fix.' },
];
