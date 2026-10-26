import { after } from 'next/server';
import type { GH } from '@/lib/github.ts';
import { deliverOutputs } from '@/lib/outputs.ts';

const DELIVERING = new Set<string>(); // задачи, чьи файлы этот экземпляр уже переносит: опрос не начнёт второй перенос

/** Сессия оставила готовые файлы в out/ ветки (`pending`) — перенести их в черновик после ответа (lib/outputs.ts):
 *  ролик или прокси появятся на следующем опросе. Сбой — в лог; следующий опрос попробует снова. */
export function deliverLater(g: GH, id: string, pending: boolean | undefined): void {
  if (!pending || DELIVERING.has(id)) return;
  DELIVERING.add(id);
  after(async () => {
    try {
      await deliverOutputs(g, id);
    } catch (e) {
      console.error(`перенос готовых файлов ${id}:`, e);
    } finally {
      DELIVERING.delete(id);
    }
  });
}
