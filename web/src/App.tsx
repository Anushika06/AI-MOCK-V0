import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { MockPage } from './pages/MockPage';
import { ExamPage } from './pages/ExamPage';
import { ResultPage } from './pages/ResultPage';
import { HistoryPage } from './pages/HistoryPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The exam screen is full-bleed, without the app navigation. */}
        <Route path="/attempts/:attemptId" element={<ExamPage />} />
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/mocks/:mockId" element={<MockPage />} />
          <Route path="/attempts/:attemptId/result" element={<ResultPage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
