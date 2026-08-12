import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { fetchSettings, updateSettings } from '../api/settings';
import {
  CreateTelegramContentInput,
  createTelegramInstruction,
  createTelegramNews,
  deleteTelegramInstruction,
  deleteTelegramNews,
  fetchTelegramInstructions,
  fetchTelegramNews,
} from '../api/telegramContent';
import {
  approveTelegramRegistration,
  broadcastTelegramMessage,
  deleteTelegramBroadcast,
  deleteTelegramRegistration,
  fetchTelegramBotLogs,
  fetchTelegramBroadcasts,
  fetchTelegramRegistrations,
} from '../api/telegramRegistrations';
import { TelegramContentPost, TelegramRegistration } from '../api/types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface ContentSectionProps {
  description: string;
  items: TelegramContentPost[] | undefined;
  isLoading: boolean;
  onCreate: (input: CreateTelegramContentInput) => void;
  isCreating: boolean;
  onDelete: (id: string) => void;
  isDeleting: boolean;
  emptyText: string;
}

// Общая форма+лента для новостей и инструкций — у них одинаковая структура контента
// (заголовок+текст+картинки), различается только назначение и то, как их отдаёт бот.
function ContentSection({
  description,
  items,
  isLoading,
  onCreate,
  isCreating,
  onDelete,
  isDeleting,
  emptyText,
}: ContentSectionProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList) {
      return;
    }
    setImageError(null);
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError(`Файл «${file.name}» больше 5 МБ — пропущен.`);
        continue;
      }
      const dataUri = await readFileAsDataUri(file);
      setImages((prev) => [...prev, dataUri]);
    }
  };

  const handleSubmit = () => {
    onCreate({ title: title.trim() || undefined, body, images });
    setTitle('');
    setBody('');
    setImages([]);
    setImageError(null);
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography variant="body2" color="text.secondary" mb={2}>
        {description}
      </Typography>
      <Stack spacing={1.5} sx={{ maxWidth: 480, mb: 3 }}>
        <TextField label="Заголовок (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextField
          label="Текст (ссылки можно вставлять прямо в текст — бот покажет их кликабельными)"
          multiline
          minRows={3}
          maxRows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button component="label" variant="outlined" sx={{ alignSelf: 'flex-start' }}>
          Прикрепить картинки
          <input type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
        </Button>
        {images.length > 0 && (
          <Stack direction="row" spacing={1} flexWrap="wrap">
            {images.map((img, index) => (
              <Box key={index} sx={{ position: 'relative' }}>
                <Box component="img" src={img} alt="" sx={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 1 }} />
                <IconButton
                  size="small"
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                  sx={{ position: 'absolute', top: -10, right: -10, bgcolor: 'background.paper', boxShadow: 1 }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Stack>
        )}
        {imageError && <Alert severity="warning">{imageError}</Alert>}
        <Button variant="contained" sx={{ alignSelf: 'flex-start' }} disabled={!body.trim() || isCreating} onClick={handleSubmit}>
          Опубликовать
        </Button>
      </Stack>
      <Stack spacing={1.5}>
        {items?.map((post) => (
          <Paper key={post.id} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
              <Box sx={{ minWidth: 0 }}>
                {post.title && (
                  <Typography variant="subtitle2" sx={{ wordBreak: 'break-word' }}>
                    {post.title}
                  </Typography>
                )}
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {post.body}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(post.createdAt).toLocaleString()}
                </Typography>
              </Box>
              <Button size="small" color="error" onClick={() => onDelete(post.id)} disabled={isDeleting} sx={{ flexShrink: 0 }}>
                Удалить
              </Button>
            </Stack>
            {post.images.length > 0 && (
              <Stack direction="row" spacing={1} mt={1} flexWrap="wrap">
                {post.images.map((img, index) => (
                  <Box key={index} component="img" src={img} alt="" sx={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 1 }} />
                ))}
              </Stack>
            )}
          </Paper>
        ))}
        {!isLoading && (items?.length ?? 0) === 0 && (
          <Typography variant="body2" color="text.secondary">
            {emptyText}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

const statusLabels: Record<string, string> = {
  pending: 'Ожидает подтверждения',
  approved: 'Подтверждён',
};

const statusColor: Record<string, 'warning' | 'success'> = {
  pending: 'warning',
  approved: 'success',
};

const logLevelColor: Record<string, 'default' | 'warning' | 'error'> = {
  info: 'default',
  warn: 'warning',
  error: 'error',
};

export function TelegramBotPage() {
  const queryClient = useQueryClient();
  const { data: registrations, isLoading } = useQuery({
    queryKey: ['telegram-registrations'],
    queryFn: fetchTelegramRegistrations,
  });

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [textsSaved, setTextsSaved] = useState(false);
  const [textsError, setTextsError] = useState<string | null>(null);
  useEffect(() => {
    if (settings) {
      setWelcomeMessage(settings.telegramWelcomeMessage ?? '');
      setInfoMessage(settings.telegramInfoMessage ?? '');
    }
  }, [settings]);
  const saveTextsMutation = useMutation({
    mutationFn: () => updateSettings({ telegramWelcomeMessage: welcomeMessage, telegramInfoMessage: infoMessage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setTextsSaved(true);
      setTextsError(null);
    },
    onError: (err) => {
      setTextsError(getErrorMessage(err, 'Не удалось сохранить тексты бота'));
      setTextsSaved(false);
    },
  });

  const { data: news, isLoading: newsLoading } = useQuery({ queryKey: ['telegram-news'], queryFn: fetchTelegramNews });
  const createNewsMutation = useMutation({
    mutationFn: createTelegramNews,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-news'] }),
  });
  const deleteNewsMutation = useMutation({
    mutationFn: deleteTelegramNews,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-news'] }),
  });

  const { data: instructions, isLoading: instructionsLoading } = useQuery({
    queryKey: ['telegram-instructions'],
    queryFn: fetchTelegramInstructions,
  });
  const createInstructionMutation = useMutation({
    mutationFn: createTelegramInstruction,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-instructions'] }),
  });
  const deleteInstructionMutation = useMutation({
    mutationFn: deleteTelegramInstruction,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-instructions'] }),
  });

  const approveMutation = useMutation({
    mutationFn: approveTelegramRegistration,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] }),
  });
  const [deleteTarget, setDeleteTarget] = useState<TelegramRegistration | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (revokePeers: boolean) => deleteTelegramRegistration(deleteTarget!.id, revokePeers),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] });
      setDeleteTarget(null);
    },
  });

  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastPin, setBroadcastPin] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const broadcastMutation = useMutation({
    mutationFn: () => broadcastTelegramMessage(broadcastText, broadcastPin),
    onSuccess: (result) => {
      setBroadcastResult(`Отправлено: ${result.sent}${result.failed > 0 ? `, не удалось: ${result.failed}` : ''}`);
      setBroadcastError(null);
      setBroadcastText('');
      queryClient.invalidateQueries({ queryKey: ['telegram-broadcasts'] });
    },
    onError: (err) => {
      setBroadcastError(getErrorMessage(err, 'Не удалось отправить рассылку'));
      setBroadcastResult(null);
    },
  });

  const { data: broadcasts, isLoading: broadcastsLoading } = useQuery({
    queryKey: ['telegram-broadcasts'],
    queryFn: fetchTelegramBroadcasts,
  });
  const deleteBroadcastMutation = useMutation({
    mutationFn: deleteTelegramBroadcast,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-broadcasts'] }),
  });

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['telegram-bot-logs'],
    queryFn: fetchTelegramBotLogs,
    refetchInterval: 15_000,
  });

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Telegram-бот</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Регистрации
        </Typography>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ФИО</TableCell>
                <TableCell>Организация</TableCell>
                <TableCell>Telegram</TableCell>
                <TableCell>Статус</TableCell>
                <TableCell align="right">Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {registrations?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.fullName}</TableCell>
                  <TableCell>{r.organizationName}</TableCell>
                  <TableCell>{r.telegramUsername ? `@${r.telegramUsername}` : r.telegramChatId}</TableCell>
                  <TableCell>
                    <Chip size="small" label={statusLabels[r.status] ?? r.status} color={statusColor[r.status]} />
                  </TableCell>
                  <TableCell align="right">
                    {r.status === 'pending' && (
                      <Button size="small" onClick={() => approveMutation.mutate(r.id)} disabled={approveMutation.isPending}>
                        Подтвердить
                      </Button>
                    )}
                    <Button size="small" color="error" onClick={() => setDeleteTarget(r)}>
                      Удалить
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && (registrations?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>Регистраций пока нет</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Тексты бота</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
            <TextField
              label="Приветствие (первое сообщение на /start)"
              multiline
              minRows={2}
              maxRows={6}
              value={welcomeMessage}
              onChange={(e) => {
                setWelcomeMessage(e.target.value);
                setTextsSaved(false);
              }}
            />
            <TextField
              label="Дополнительная информация (кнопка «ℹ️ Информация»)"
              multiline
              minRows={2}
              maxRows={6}
              value={infoMessage}
              onChange={(e) => {
                setInfoMessage(e.target.value);
                setTextsSaved(false);
              }}
            />
            <Button
              variant="outlined"
              sx={{ alignSelf: 'flex-start' }}
              disabled={saveTextsMutation.isPending}
              onClick={() => saveTextsMutation.mutate()}
            >
              Сохранить
            </Button>
            {textsSaved && <Alert severity="success">Тексты сохранены.</Alert>}
            {textsError && <Alert severity="error">{textsError}</Alert>}
          </Stack>
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Новости</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <ContentSection
            description="Кнопка «📰 Новости» в боте показывает последние 5 постов (плюс картинки отдельными сообщениями)."
            items={news}
            isLoading={newsLoading}
            onCreate={(input) => createNewsMutation.mutate(input)}
            isCreating={createNewsMutation.isPending}
            onDelete={(id) => deleteNewsMutation.mutate(id)}
            isDeleting={deleteNewsMutation.isPending}
            emptyText="Новостей пока нет"
          />
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Инструкции</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <ContentSection
            description="Кнопка «📘 Инструкции» в боте показывает все карточки целиком, в порядке публикации."
            items={instructions}
            isLoading={instructionsLoading}
            onCreate={(input) => createInstructionMutation.mutate(input)}
            isCreating={createInstructionMutation.isPending}
            onDelete={(id) => deleteInstructionMutation.mutate(id)}
            isDeleting={deleteInstructionMutation.isPending}
            emptyText="Инструкций пока нет"
          />
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Рассылка подтверждённым пользователям</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
            <TextField
              label="Текст сообщения"
              multiline
              minRows={3}
              maxRows={8}
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
            />
            <FormControlLabel
              control={<Checkbox checked={broadcastPin} onChange={(e) => setBroadcastPin(e.target.checked)} />}
              label="Закрепить сообщение в чате у получателей"
            />
            <Button
              variant="contained"
              sx={{ alignSelf: 'flex-start' }}
              disabled={!broadcastText.trim() || broadcastMutation.isPending}
              onClick={() => broadcastMutation.mutate()}
            >
              Отправить всем подтверждённым
            </Button>
            {broadcastResult && <Alert severity="success">{broadcastResult}</Alert>}
            {broadcastError && <Alert severity="error">{broadcastError}</Alert>}
          </Stack>
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">История рассылок</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Удаление рассылки убирает сообщение из чата у всех получателей, не только из этого
            списка.
          </Typography>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Текст</TableCell>
                  <TableCell align="right">Получателей</TableCell>
                  <TableCell>Закреплено</TableCell>
                  <TableCell>Отправлено</TableCell>
                  <TableCell align="right">Действия</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {broadcasts?.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell sx={{ maxWidth: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.text}</TableCell>
                    <TableCell align="right">{b.recipientCount}</TableCell>
                    <TableCell>{b.pinned ? 'да' : '—'}</TableCell>
                    <TableCell>{new Date(b.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="error"
                        onClick={() => deleteBroadcastMutation.mutate(b.id)}
                        disabled={deleteBroadcastMutation.isPending}
                      >
                        Удалить
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!broadcastsLoading && (broadcasts?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>Рассылок пока не было</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Журнал бота</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <TableContainer sx={{ overflowX: 'auto', maxHeight: 480 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Время</TableCell>
                  <TableCell>Уровень</TableCell>
                  <TableCell>Chat ID</TableCell>
                  <TableCell>Сообщение</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {logs?.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(entry.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Chip size="small" label={entry.level} color={logLevelColor[entry.level]} />
                    </TableCell>
                    <TableCell>{entry.chatId ?? '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.message}</TableCell>
                  </TableRow>
                ))}
                {!logsLoading && (logs?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>Записей пока нет</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </AccordionDetails>
      </Accordion>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Удалить заявку «{deleteTarget?.fullName}»?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Что сделать с уже выданными этому пользователю peers (если есть)?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Отмена</Button>
          <Button onClick={() => deleteMutation.mutate(false)} disabled={deleteMutation.isPending}>
            Оставить peers
          </Button>
          <Button color="error" onClick={() => deleteMutation.mutate(true)} disabled={deleteMutation.isPending}>
            Отозвать и удалить peers
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
