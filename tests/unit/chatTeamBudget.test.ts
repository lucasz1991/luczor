import { expect, it } from 'vitest'
import { chatTeamBudget } from '@/services/agents/chatTeamBudget'

it('gives a configured multi-round worker time beyond the old fixed deadline', () => {
  const budget = chatTeamBudget(17, 3, 3)
  expect(budget.workerTimeoutMs).toBe(51 * 60_000)
  expect(budget.deadlineMs).toBe(96 * 60_000)
})

it('bounds execution and budgets sequential specialist waves', () => {
  expect(chatTeamBudget(1000, 4, 1)).toEqual({
    workerTimeoutMs: 60 * 60_000,
    deadlineMs: 150 * 60_000,
  })
  expect(chatTeamBudget(Number.NaN, 0, 1).workerTimeoutMs).toBe(15 * 60_000)
  expect(chatTeamBudget(1, 0, 1).deadlineMs).toBe(45 * 60_000)
})
