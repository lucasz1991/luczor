import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ChatProjectOverlay from '@/components/ChatProjectOverlay.vue'

describe('project overlay disclosures', () => {
  async function render(props: Record<string, unknown> = {}) {
    return renderToString(
      createSSRApp({
        render: () =>
          h(
            ChatProjectOverlay,
            { projectId: 'project-a', goalCount: 4, goalsDone: 1, ...props },
            {
              context: () => h('p', 'Ein Projektziel'),
              checklist: () => h('button', { type: 'button' }, 'Im Planungsfenster ausarbeiten'),
            }
          ),
      })
    )
  }

  it('keeps goals available while hiding the absent checklist and starts collapsed', async () => {
    const html = await render()
    expect(html).toContain('Projektziele</span>')
    expect(html).toContain('1 von 4 Zielen erledigt')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Checkliste</span>')
    expect(html).not.toContain('Im Planungsfenster ausarbeiten')
  })

  it('renders independent controlled disclosures with their accessible panel relationships', async () => {
    const html = await render({
      hasChecklist: true,
      contextExpanded: true,
      checklistExpanded: false,
      checklistCount: 8,
      checklistDone: 3,
    })
    expect(html).toContain('3 von 8 Schritten erledigt')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/aria-controls="[^"]+-context"/)
    expect(html).toMatch(/aria-labelledby="[^"]+-context-toggle"/)
    expect(html).toMatch(/<section[^>]+id="[^"]+-checklist"[^>]+style="display:none;"/)
    expect(html).toContain('Im Planungsfenster ausarbeiten')
  })

  it('keeps both supplied sections available when expanded without duplicating their actions', async () => {
    const html = await render({ hasChecklist: true, contextExpanded: true, checklistExpanded: true })
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(html).not.toContain('display:none')
    expect(html.match(/Im Planungsfenster ausarbeiten/g)).toHaveLength(1)
    expect(html).toContain('Ein Projektziel')
  })
})
